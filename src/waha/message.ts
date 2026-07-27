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
