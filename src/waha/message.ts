/**
 * WAHA payload shapes differ by engine (`gows` / `noweb` / `webjs`), so anything that
 * reaches into a payload does it here and tolerates all of them.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Every string that could plausibly identify this message, most-specific first.
 * `_serialized` / a bare string `id` are the forms that also appear on webhook payloads,
 * which is what makes ack and echo matching work across engines.
 */
export function messageIdCandidates(value: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v)
  }
  const root = asRecord(value)
  if (!root) return out

  const id = root.id
  if (typeof id === 'string') push(id)
  const idObj = asRecord(id)
  if (idObj) {
    push(idObj._serialized)
    push(idObj.id)
  }
  const key = asRecord(root.key)
  if (key) push(key.id)

  const messages = root.messages
  if (Array.isArray(messages)) for (const m of messages) out.push(...messageIdCandidates(m))

  push(root.messageId)
  return out
}

export function primaryMessageId(value: unknown): string | null {
  return messageIdCandidates(value)[0] ?? null
}

export interface ObservedMessage {
  chatId: string | null
  fromMe: boolean
  body: string
  ids: string[]
  /**
   * The counterpart's phone JID, when the engine sent one alongside an anonymous LID.
   * This is what lets the guard put a `@lid` reply and a `@c.us` send on one contact
   * without a round trip.
   */
  altJid: string | null
}

/**
 * GOWS carries the counterpart's phone JID next to the LID — `SenderAlt` on a message from
 * them, `RecipientAlt` on one from us — as e.g. `351912973590@s.whatsapp.net`.
 */
function altJidFromPayload(p: Record<string, unknown>, fromMe: boolean): string | null {
  const info = asRecord(asRecord(p._data)?.Info)
  if (!info) return null
  const alt = fromMe ? info.RecipientAlt : info.SenderAlt
  return typeof alt === 'string' && alt.length > 0 ? alt : null
}

export function observeMessage(payload: unknown): ObservedMessage | null {
  const p = asRecord(payload)
  if (!p) return null
  const fromMe = p.fromMe === true || asRecord(p.id)?.fromMe === true
  const chatId =
    (typeof p.chatId === 'string' && p.chatId) ||
    (fromMe ? typeof p.to === 'string' && p.to : typeof p.from === 'string' && p.from) ||
    (typeof p.from === 'string' ? p.from : null) ||
    null
  const body =
    (typeof p.body === 'string' && p.body) ||
    (typeof p.caption === 'string' && p.caption) ||
    (typeof p.text === 'string' && p.text) ||
    ''
  return {
    chatId: chatId || null,
    fromMe,
    body,
    ids: messageIdCandidates(p),
    altJid: altJidFromPayload(p, fromMe),
  }
}

/**
 * Events that mean **this person did something in our chat, of their own accord**.
 *
 * `requireHumanTouch` asks one question: has this human engaged with us, or are we about to
 * cold-open a stranger? A message is the obvious yes, but it is not the only one. Someone
 * who rings the line, reacts 👍 to a job offer, votes in a poll, or sends something and
 * deletes it has engaged just as plainly — and until this existed the guard saw none of it
 * and refused to let us answer. A caller who never types could not be replied to at all, and
 * the reply being refused was the *"I can't take calls, send me a message"* line, which is
 * the only useful thing to say to them.
 *
 * **What is deliberately not here: read receipts and typing/presence.** They look like
 * interactions and are not — they fire in reaction to a message *we* sent. Counting them
 * would mean any cold outreach unlocks itself the moment the target opens it, which retires
 * the gate this whole file exists to serve. The test for membership is not "did an event
 * arrive from their side" but "would this have happened if we had never written to them".
 * Founder decision, 2026-08-01.
 *
 * `call.accepted` / `call.rejected` are absent for a different reason: our lines never
 * answer, so WhatsApp terminates the call itself and emits a second event ~20s later under
 * the same call id. One call is one interaction.
 */
export const INTERACTION_EVENTS = new Set([
  'call.received',
  'message.reaction',
  'message.revoked',
  'message.edited',
  'poll.vote',
])

/**
 * Read one of those events as "who did this, and in which chat" — the two things the store
 * needs and the only two the guard cares about. The rendering of these events into readable
 * lines is the mailbox's job, not ours.
 *
 * Each event type hides the chat somewhere else: a call uses `from`, a poll vote nests it
 * under `vote.from`, a group event under `group.id`, and **a revoke describes the deleted
 * message under `after`** — the envelope itself carries neither the chat nor `fromMe`, so
 * reading the top level would silently credit every deletion to the wrong side.
 */
export function observeInteraction(event: string, payload: unknown): ObservedMessage | null {
  const root = asRecord(payload)
  if (!root) return null
  // A revoke is an envelope around the message that was deleted; everything true about
  // who and where lives on the inner one.
  const p = event === 'message.revoked' ? (asRecord(root.after) ?? root) : root

  const fromMe = p.fromMe === true || asRecord(p.id)?.fromMe === true
  const vote = asRecord(p.vote)
  const group = asRecord(p.group)
  const chatId =
    (typeof p.from === 'string' && p.from) ||
    (typeof p.chatId === 'string' && p.chatId) ||
    (typeof p.to === 'string' && p.to) ||
    (typeof group?.id === 'string' && group.id) ||
    (typeof vote?.from === 'string' && vote.from) ||
    null
  if (!chatId) return null

  return {
    chatId,
    fromMe,
    body: '',
    // The event name is part of the id: a call emits `call.received` and (on other
    // engines) a second event under the *same* call id, and `inbound` dedupes on the id
    // alone — without the prefix the second would look like a redelivery of the first.
    ids: messageIdCandidates(p).map((id) => `${event}:${id}`),
    altJid: altJidFromPayload(p, fromMe),
  }
}

/** WAHA ack levels; `ackName` is the string form on some engines. */
const ACK_NAMES: Record<string, number> = {
  ERROR: -1,
  PENDING: 0,
  SERVER: 1,
  DEVICE: 2,
  READ: 3,
  PLAYED: 4,
}

export function ackLevel(payload: unknown): number | null {
  const p = asRecord(payload)
  if (!p) return null
  if (typeof p.ack === 'number') return p.ack
  if (typeof p.ackName === 'string' && p.ackName in ACK_NAMES) return ACK_NAMES[p.ackName]!
  return null
}

/**
 * The chat id a send request targets. `chatId` is the documented field; `to` and `phone`
 * appear on a few routes and in older client code.
 */
export function chatIdFromSendBody(body: unknown): string | null {
  const b = asRecord(body)
  if (!b) return null
  for (const field of ['chatId', 'to', 'phone', 'groupId']) {
    const v = b[field]
    if (typeof v === 'string' && v.length > 0) return v
  }
  const message = asRecord(b.message)
  if (message) return chatIdFromSendBody(message)
  return null
}

/**
 * Group (`@g.us`) and channel (`@newsletter`) chats have no individual on the other end, so
 * the contact gates — every one of which describes a relationship with a person — do not
 * mean anything for them. `requireHumanTouch` on a group the business owns is a refusal to
 * post to your own announcement channel; `handshakeMaxMessages` mutes it after one message
 * nobody happened to reply to.
 */
export function isGroupChatId(chatId: string | null | undefined): boolean {
  if (!chatId) return false
  return chatId.endsWith('@g.us') || chatId.endsWith('@newsletter')
}

export function sessionFromSendBody(body: unknown): string | null {
  const b = asRecord(body)
  const v = b?.session
  return typeof v === 'string' && v.length > 0 ? v : null
}

export function textFromSendBody(body: unknown, field: 'text' | 'caption' | null): string {
  if (!field) return ''
  const b = asRecord(body)
  const v = b?.[field]
  return typeof v === 'string' ? v : ''
}
