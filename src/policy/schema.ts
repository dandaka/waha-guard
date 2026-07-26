/**
 * Policy schema and presets.
 *
 * Every number here is a policy choice, not a law of physics. The provenance of each
 * default is documented in docs/policy.md. None of them are measurements; most are
 * conservative guesses. Treat them as guesses.
 */

export type PresetName = 'conservative' | 'balanced' | 'off'

/** How the guard reacts when a gate says no. */
export type EnforcementMode =
  /** Refuse the send (429/403). The point of the guard. */
  | 'enforce'
  /** Log the decision and forward anyway. For shadow-running against real traffic. */
  | 'observe'

export type BackpressureMode =
  /** Hold the HTTP request until the message actually goes out. Keeps WAHA's contract. */
  | 'block'
  /** Return 202 + a guard-side id, send later, emit guard.sent / guard.dropped. */
  | 'queue'

/** Exactly one side may own typing indicators, or they interleave visibly. */
export type PresenceOwner = 'guard' | 'caller' | 'off'

export type ContactState = 'stranger' | 'handshake_sent' | 'known' | 'opted_out'

/** What to do with a send route the guard does not know about. */
export type UnknownSendRouteAction = 'block' | 'pass'

export type ReplyRatioAction = 'block-strangers' | 'block-all' | 'slow'

export interface QuietHoursPolicy {
  enabled: boolean
  /** IANA zone, e.g. 'Europe/Lisbon'. Recipient-local is the intent; per-session override it. */
  timezone: string
  /** 'HH:MM' inclusive start of the quiet window. May wrap past midnight. */
  start: string
  /** 'HH:MM' exclusive end of the quiet window. */
  end: string
  /** Days quiet hours apply to, 0 = Sunday. Empty means every day. */
  days: number[]
  /** Whole days that are quiet end-to-end, 0 = Sunday. */
  quietDays: number[]
}

export interface RatePolicy {
  /** Sliding windows, per session. Counted from the sends table, never from a fixed counter. */
  perMinute: number
  perHour: number
  perDay: number
  /** Floor on the gap between two consecutive sends in a session. */
  minSpacingMs: number
  /** Gaussian jitter added to the spacing. Truncated at ±2σ, never negative. */
  jitterStddevMs: number
  /** Spacing multiplier by contact state — strangers get paced slower than replies. */
  stateMultipliers: Record<ContactState, number>
}

export interface WarmupStep {
  /** Applies from this day of the session's warmup onward (day 0 = first day). */
  fromDay: number
  maxPerDay: number
  maxNewContactsPerDay: number
}

export interface WarmupPolicy {
  enabled: boolean
  /** Ordered ascending by fromDay. The last step applies indefinitely. */
  schedule: WarmupStep[]
}

export interface ContactPolicy {
  /**
   * Refuse to send to any contact the guard has never seen a human touch on — either an
   * inbound message, or an outbound message the guard did not send (typed on the phone).
   * This is the relationship control; it is the whole reason the webhook side exists.
   */
  requireHumanTouch: boolean
  /** New strangers (first ever outbound) allowed per session per rolling day. */
  maxNewStrangersPerDay: number
  /** Messages allowed to a contact that has never replied. */
  handshakeMaxMessages: number
}

export interface ReplyRatioPolicy {
  enabled: boolean
  /** Outbound-per-inbound ceiling over the window. */
  maxOutPerIn: number
  /** Do not act until this many outbound messages exist in the window. */
  minSamples: number
  windowHours: number
  action: ReplyRatioAction
  /** Spacing multiplier applied when action is 'slow'. */
  slowMultiplier: number
}

export interface OptOutPolicy {
  enabled: boolean
  /** Case-insensitive; matched against the whole trimmed inbound body. */
  keywords: string[]
}

export interface TypingPolicy {
  enabled: boolean
  wpmMean: number
  wpmStddev: number
  wpmMin: number
  wpmMax: number
  /** Hard cap on a single typing plan. Interacts with backpressure.maxWaitMs. */
  maxPlanMs: number
  /** Re-issue `composing` at least this often — the presence expires server-side. */
  refreshMs: number
  /** Pause ("thinking") between composing bursts, for plans longer than one burst. */
  pauseMinMs: number
  pauseMaxMs: number
  /** Chars per word used to convert body length to words. */
  charsPerWord: number
}

export interface TimelockPolicy {
  enabled: boolean
  /** Upstream statuses that mean "you are being rate-limited / timelocked". */
  detectStatuses: number[]
  /** Substrings in an upstream error body that mean the same. Case-insensitive. */
  detectBodyPatterns: string[]
  /** How long to stay in degraded mode after the last detection. */
  degradeMinutes: number
  /** Spacing multiplier at the moment of detection. Decays to 1 over recoveryHours. */
  degradedMultiplier: number
  recoveryHours: number
  /** In degraded mode, only messages to `known` contacts are allowed through. */
  strangersBlockedWhileDegraded: boolean
}

export interface AckPolicy {
  enabled: boolean
  /** Look at the last N sends when computing the undelivered ratio. */
  sampleSize: number
  /** Above this undelivered ratio, apply slowMultiplier. */
  maxUndeliveredRatio: number
  slowMultiplier: number
  /** A send with no ack after this long counts as undelivered. */
  graceMinutes: number
}

export interface RoutePolicy {
  /**
   * A send route the guard does not recognise is a bypass. Default is to refuse it and
   * say so, because silently passing it defeats the guard. Waive consciously.
   */
  unknownSends: UnknownSendRouteAction
  /** Exact paths (no session prefix) waived from the unknownSends rule. */
  waived: string[]
}

export interface SessionPolicy {
  mode: EnforcementMode
  presence: PresenceOwner
  backpressure: { mode: BackpressureMode; maxWaitMs: number }
  quietHours: QuietHoursPolicy
  rates: RatePolicy
  warmup: WarmupPolicy
  contacts: ContactPolicy
  replyRatio: ReplyRatioPolicy
  optOut: OptOutPolicy
  typing: TypingPolicy
  timelock: TimelockPolicy
  ack: AckPolicy
  routes: RoutePolicy
}

export interface Policy extends SessionPolicy {
  preset: PresetName
  /** Per-session overrides, deep-merged over the base. */
  sessions: Record<string, DeepPartial<SessionPolicy>>
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K]
}

const conservative: SessionPolicy = {
  mode: 'enforce',
  presence: 'guard',
  backpressure: { mode: 'block', maxWaitMs: 120_000 },
  quietHours: {
    enabled: true,
    timezone: 'UTC',
    start: '21:00',
    end: '09:00',
    days: [],
    quietDays: [],
  },
  rates: {
    perMinute: 3,
    perHour: 30,
    perDay: 150,
    minSpacingMs: 20_000,
    jitterStddevMs: 8_000,
    stateMultipliers: { known: 1, handshake_sent: 2, stranger: 3, opted_out: 1 },
  },
  warmup: {
    enabled: true,
    schedule: [
      { fromDay: 0, maxPerDay: 20, maxNewContactsPerDay: 5 },
      { fromDay: 3, maxPerDay: 40, maxNewContactsPerDay: 10 },
      { fromDay: 7, maxPerDay: 80, maxNewContactsPerDay: 15 },
      { fromDay: 14, maxPerDay: 150, maxNewContactsPerDay: 25 },
    ],
  },
  contacts: {
    requireHumanTouch: true,
    maxNewStrangersPerDay: 5,
    handshakeMaxMessages: 1,
  },
  replyRatio: {
    enabled: true,
    maxOutPerIn: 3,
    minSamples: 20,
    windowHours: 24,
    action: 'block-strangers',
    slowMultiplier: 2,
  },
  optOut: {
    enabled: true,
    keywords: ['stop', 'unsubscribe', 'remove me', 'opt out', 'optout', 'no thanks'],
  },
  typing: {
    enabled: true,
    wpmMean: 42,
    wpmStddev: 12,
    wpmMin: 20,
    wpmMax: 80,
    maxPlanMs: 25_000,
    refreshMs: 8_000,
    pauseMinMs: 700,
    pauseMaxMs: 2_500,
    charsPerWord: 5,
  },
  timelock: {
    enabled: true,
    detectStatuses: [429, 463],
    detectBodyPatterns: ['rate-overlimit', 'rate overlimit', 'timelock', 'too many requests'],
    degradeMinutes: 60,
    degradedMultiplier: 5,
    recoveryHours: 24,
    strangersBlockedWhileDegraded: true,
  },
  ack: {
    enabled: true,
    sampleSize: 50,
    maxUndeliveredRatio: 0.3,
    slowMultiplier: 2,
    graceMinutes: 10,
  },
  routes: { unknownSends: 'block', waived: [] },
}

const balanced: SessionPolicy = structuredClone(conservative)
balanced.rates = {
  perMinute: 6,
  perHour: 80,
  perDay: 400,
  minSpacingMs: 8_000,
  jitterStddevMs: 4_000,
  stateMultipliers: { known: 1, handshake_sent: 1.5, stranger: 2, opted_out: 1 },
}
balanced.warmup.schedule = [
  { fromDay: 0, maxPerDay: 40, maxNewContactsPerDay: 10 },
  { fromDay: 3, maxPerDay: 100, maxNewContactsPerDay: 20 },
  { fromDay: 7, maxPerDay: 200, maxNewContactsPerDay: 40 },
  { fromDay: 14, maxPerDay: 400, maxNewContactsPerDay: 60 },
]
balanced.contacts = {
  requireHumanTouch: false,
  maxNewStrangersPerDay: 20,
  handshakeMaxMessages: 2,
}
balanced.replyRatio.maxOutPerIn = 6

/**
 * `off` is a pure pass-through with state still recorded. It exists so a user can adopt
 * the guard (P0) without adopting any policy, and turn gates on one at a time.
 */
const off: SessionPolicy = structuredClone(conservative)
off.presence = 'caller'
off.quietHours.enabled = false
off.rates = {
  perMinute: Number.POSITIVE_INFINITY,
  perHour: Number.POSITIVE_INFINITY,
  perDay: Number.POSITIVE_INFINITY,
  minSpacingMs: 0,
  jitterStddevMs: 0,
  stateMultipliers: { known: 1, handshake_sent: 1, stranger: 1, opted_out: 1 },
}
off.warmup.enabled = false
off.contacts = {
  requireHumanTouch: false,
  maxNewStrangersPerDay: Number.POSITIVE_INFINITY,
  handshakeMaxMessages: Number.POSITIVE_INFINITY,
}
off.replyRatio.enabled = false
off.optOut.enabled = false
off.typing.enabled = false
off.timelock.enabled = false
off.ack.enabled = false
off.routes = { unknownSends: 'pass', waived: [] }

export const PRESETS: Record<PresetName, SessionPolicy> = { conservative, balanced, off }

export function presetPolicy(name: PresetName): Policy {
  return { preset: name, sessions: {}, ...structuredClone(PRESETS[name]) }
}
