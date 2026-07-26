/**
 * Which upstream paths create a message.
 *
 * The failure mode this table exists to prevent: a caller that gets a 429 on `sendText`
 * discovers that `sendImage` is unguarded and moves its traffic there. Every route that
 * puts a message on the wire must be intercepted, or the guard is decorative.
 *
 * This table has not been audited against a specific WAHA release, and a hand-maintained
 * list of someone else's endpoints will always lag. That is why an unrecognised
 * send-shaped path fails closed instead of passing through: the guard does not need the
 * list to be complete, it needs to notice when it is not.
 */

export type RouteKind =
  /** Creates a message. Full pipeline applies. */
  | 'send'
  /** Presence — passes through unless the guard owns presence for that session. */
  | 'presence'
  /** Anything else: proxied byte-for-byte. */
  | 'passthrough'

export interface RouteMatch {
  kind: RouteKind
  /** Canonical name, e.g. 'sendText'. */
  name: string
  /** Session taken from the path, if the route is session-scoped. */
  sessionFromPath?: string
  /** Which body field carries the text that drives the WPM model. */
  textField?: 'text' | 'caption' | null
}

/** Message-creating routes under /api/. */
const SEND_ROUTES: Record<string, { textField: 'text' | 'caption' | null }> = {
  sendText: { textField: 'text' },
  sendImage: { textField: 'caption' },
  sendFile: { textField: 'caption' },
  sendVoice: { textField: null },
  sendVideo: { textField: 'caption' },
  sendButtons: { textField: 'text' },
  sendList: { textField: 'text' },
  sendPoll: { textField: null },
  sendPollVote: { textField: null },
  sendLocation: { textField: null },
  sendContactVcard: { textField: null },
  sendLinkPreview: { textField: 'text' },
  'send/link-custom-preview': { textField: 'text' },
  'send/buttons/reply': { textField: 'text' },
  // Message-creating routes outside the chatting controller. Forwarding and reactions put
  // a message on the wire exactly like a send does; leaving them out was the bypass the
  // P0 route audit was for.
  forwardMessage: { textField: null },
  reaction: { textField: null },
  star: { textField: null },
}

/** Session-scoped message-creating routes: /api/{session}/<suffix>. */
const SCOPED_SEND_SUFFIXES: Record<string, { name: string; textField: 'text' | 'caption' | null }> =
  {
    'chats/messages': { name: 'chats/messages', textField: 'text' },
    messages: { name: 'messages', textField: 'text' },
  }

const PRESENCE_ROUTES = new Set(['startTyping', 'stopTyping', 'sendSeen', 'presence'])

/**
 * Heuristic used only to decide whether an *unrecognised* path is suspicious enough to be
 * refused under `routes.unknownSends: block`. Deliberately broad: a false positive costs a
 * config line, a false negative costs an unguarded send path.
 */
const SUSPICIOUS = /(^|\/)(send|forward|reply|broadcast|reaction|star)/i

export interface RouteTableOptions {
  /** Exact paths (leading slash, no query) waived from the unknown-send rule. */
  waived: Set<string>
}

export function classifyPath(
  pathname: string,
  method: string,
  options: RouteTableOptions,
): RouteMatch {
  const path = pathname.replace(/\/+$/, '') || '/'

  if (!path.startsWith('/api/')) return { kind: 'passthrough', name: path }
  // Only body-bearing methods create messages; a GET /api/sendText does not exist, and
  // treating it as a send would break WAHA's own OpenAPI probing.
  const bodyMethod = method === 'POST' || method === 'PUT' || method === 'PATCH'

  const rest = path.slice('/api/'.length)

  // Unscoped: /api/sendText, /api/send/buttons/reply
  const unscoped = SEND_ROUTES[rest]
  if (unscoped && bodyMethod) {
    return { kind: 'send', name: rest, textField: unscoped.textField }
  }

  const segments = rest.split('/')
  const head = segments[0]!

  if (PRESENCE_ROUTES.has(head)) return { kind: 'presence', name: head }

  // Session-scoped: /api/{session}/chats/messages, /api/{session}/startTyping
  if (segments.length >= 2) {
    const session = head
    const suffix = segments.slice(1).join('/')
    const scoped = SCOPED_SEND_SUFFIXES[suffix]
    if (scoped && bodyMethod) {
      return {
        kind: 'send',
        name: scoped.name,
        sessionFromPath: session,
        textField: scoped.textField,
      }
    }
    if (PRESENCE_ROUTES.has(suffix)) {
      return { kind: 'presence', name: suffix, sessionFromPath: session }
    }
    // /api/{session}/sendText — undocumented but harmless to support, and free to guard.
    const scopedSend = SEND_ROUTES[suffix]
    if (scopedSend && bodyMethod) {
      return {
        kind: 'send',
        name: suffix,
        sessionFromPath: session,
        textField: scopedSend.textField,
      }
    }
  }

  if (bodyMethod && !options.waived.has(path) && SUSPICIOUS.test(rest)) {
    return { kind: 'send', name: `unknown:${rest}`, textField: null }
  }

  return { kind: 'passthrough', name: path }
}

export function isUnknownSend(match: RouteMatch): boolean {
  return match.kind === 'send' && match.name.startsWith('unknown:')
}

export const KNOWN_SEND_ROUTES = Object.keys(SEND_ROUTES)
