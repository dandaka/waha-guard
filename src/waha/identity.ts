/**
 * WhatsApp identity, normalized.
 *
 * One person reaches the guard under more than one string. WhatsApp's GOWS engine reports
 * inbound senders as an anonymous LID (`60851197333718@lid`) while sends are addressed to the
 * phone (`351920266018@c.us`), and either form may turn up carrying a `:device` suffix or the
 * `@s.whatsapp.net` domain. A ledger that keys on the raw string sees two strangers where
 * there is one contact — which is how a handshake counter ends up unable to see a reply.
 *
 * Everything the guard records about a *relationship* is keyed on the identity these
 * functions produce. What goes on the wire is never rewritten: WhatsApp is addressed with
 * exactly the id the caller asked for.
 */

/** `@lid` is an identity we cannot read a phone out of; it has to be resolved, not parsed. */
export function isLidChatId(chatId: string | null | undefined): boolean {
  return typeof chatId === 'string' && chatId.toLowerCase().endsWith('@lid')
}

/**
 * The phone chatId behind a JID, or null when there is no phone in it.
 *
 * Accepts the `@s.whatsapp.net` form that GOWS uses for alt JIDs, the `@c.us` form the API
 * speaks, and the `:device` suffix either may carry. A `@lid` has no phone in it by
 * construction and returns null.
 */
export function phoneChatIdFromJid(jid: string | null | undefined): string | null {
  if (typeof jid !== 'string') return null
  const match = jid.trim().match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i)
  return match ? `${match[1]}@c.us` : null
}

/**
 * Fold the spellings of one id together. This is not resolution — it cannot turn a LID into a
 * phone, only make `351920266018:12@s.whatsapp.net` and `351920266018@c.us` the same string.
 * Anything unrecognised (groups, channels, LIDs) is returned with its domain lowercased and
 * otherwise untouched, because guessing at an id the guard does not understand is worse than
 * carrying it verbatim.
 */
export function normalizeChatId(chatId: string): string {
  const trimmed = chatId.trim()
  const phone = phoneChatIdFromJid(trimmed)
  if (phone) return phone
  const at = trimmed.lastIndexOf('@')
  if (at === -1) return trimmed
  return `${trimmed.slice(0, at)}${trimmed.slice(at).toLowerCase()}`
}
