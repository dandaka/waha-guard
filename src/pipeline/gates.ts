import type { ContactState, SessionPolicy } from '../policy/schema.ts'
import type { ContactRow, SessionStateRow, Store } from '../state/store.ts'
import { DAY, HOUR, MINUTE, quietUntil } from '../util/time.ts'
import { isGroupChatId } from '../waha/message.ts'

/**
 * Policy gates.
 *
 * Two kinds of "no", and they are not interchangeable:
 *  - `deny` — this send is not going to happen. Fail closed, 403/503, no Retry-After.
 *  - `wait` — this send is fine but not yet. In `block` mode the guard waits; past
 *    maxWaitMs it becomes a 429 + Retry-After so the caller can decide.
 *
 * Infrastructure failures are neither: they are 502s raised from the proxy, never a
 * silent drop and never an unguarded pass-through.
 */
export type GateResult =
  | { kind: 'allow' }
  | { kind: 'deny'; status: number; code: string; reason: string }
  | { kind: 'wait'; until: number; code: string; reason: string }

export interface SendContext {
  session: string
  chatId: string
  /** Length of the text/caption, if the route carries one. Drives the WPM model only. */
  textLength: number
  route: string
  now: number
  /** Drawn once per request so re-evaluation does not re-roll the dice. */
  jitterMs: number
}

export interface GateInputs {
  policy: SessionPolicy
  store: Store
  contact: ContactRow
  session: SessionStateRow
  ctx: SendContext
}

const allow: GateResult = { kind: 'allow' }

/** A group the contact gates have been told to skip. */
function groupExempt({ policy, ctx }: GateInputs): boolean {
  return policy.groups.mode === 'exempt' && isGroupChatId(ctx.chatId)
}

/**
 * An exempt group has no individual relationship to grade, so the gates that branch on
 * contact state read it as `known`. `opted_out` survives regardless: it is the one state a
 * human set deliberately, and no exemption may override it.
 */
function effectiveContactState(inputs: GateInputs): ContactState {
  const state = inputs.contact.state as ContactState
  if (state === 'opted_out') return state
  return groupExempt(inputs) ? 'known' : state
}

/** The effective spacing multiplier: contact state x whatever backoff is currently active. */
export function spacingMultiplier(inputs: GateInputs): number {
  const { policy, session, ctx, store } = inputs
  const state = effectiveContactState(inputs)
  let multiplier = policy.rates.stateMultipliers[state] ?? 1

  // Session-level backoff set by timelock detection, decaying linearly to 1.
  if (session.rate_multiplier > 1 && session.multiplier_set_at !== null) {
    const recoveryMs = policy.timelock.recoveryHours * HOUR
    const elapsed = ctx.now - session.multiplier_set_at
    const decayed =
      recoveryMs <= 0
        ? 1
        : 1 + (session.rate_multiplier - 1) * Math.max(0, 1 - elapsed / recoveryMs)
    multiplier *= Math.max(1, decayed)
  }

  if (policy.ack.enabled) {
    const { ratio, n } = store.undeliveredRatio(
      ctx.session,
      policy.ack.sampleSize,
      ctx.now - policy.ack.graceMinutes * MINUTE,
    )
    if (n >= 10 && ratio > policy.ack.maxUndeliveredRatio) multiplier *= policy.ack.slowMultiplier
  }

  if (
    policy.replyRatio.enabled &&
    policy.replyRatio.action === 'slow' &&
    replyRatioBreached(inputs)
  ) {
    multiplier *= policy.replyRatio.slowMultiplier
  }

  return multiplier
}

export function replyRatioBreached({ policy, store, ctx }: GateInputs): boolean {
  if (!policy.replyRatio.enabled) return false
  const since = ctx.now - policy.replyRatio.windowHours * HOUR
  const out = store.countSendsSince(ctx.session, since)
  if (out < policy.replyRatio.minSamples) return false
  const inbound = store.countInboundSince(ctx.session, since)
  const ratio = inbound === 0 ? Number.POSITIVE_INFINITY : out / inbound
  return ratio > policy.replyRatio.maxOutPerIn
}

export function warmupStep(policy: SessionPolicy, session: SessionStateRow, now: number) {
  if (!policy.warmup.enabled || policy.warmup.schedule.length === 0) return null
  const day = Math.floor((now - session.warmup_started_at) / DAY)
  let current = policy.warmup.schedule[0]!
  for (const step of policy.warmup.schedule) if (day >= step.fromDay) current = step
  return current
}

/**
 * Is this send us opening a conversation with a stranger — the thing the new-contact
 * budgets exist to ration?
 *
 * Cold-messaging someone off a list and answering someone who just wrote in are opposite
 * risk profiles, and they used to share one counter: any first outbound to a chat was
 * charged. So a morning of replies to an ad could spend the day's budget and silence the
 * next candidate, while genuine cold outreach stayed allowed.
 *
 * `in_count` is the half of the `requireHumanTouch` signal that answers *who contacted
 * whom*. The whole bit does not: `human_touch_at` is also set by a human sending from the
 * phone and by `markHumanTouch`, which under `requireHumanTouch` is how every permitted
 * cold send gets unlocked in the first place — keying on it would exempt precisely the
 * traffic this budget exists to cap. Since no send has gone out yet here, any inbound at
 * all means they wrote first.
 *
 * Both budgets branch here, and `countNewStrangersSince` applies the same rule to the
 * counter — a gate that exempts a send the counter still charges for only moves the wall.
 */
function opensAStranger(inputs: GateInputs): boolean {
  const { contact } = inputs
  // A group you were added to is not a stranger you chose to cold-message.
  if (groupExempt(inputs)) return false
  // Only a *first ever* send to a chat can open one.
  if (contact.out_count > 0) return false
  return contact.in_count === 0
}

// ---- individual gates -------------------------------------------------------

function sessionStopped({ session }: GateInputs): GateResult {
  if (!session.stopped_reason) return allow
  return {
    kind: 'deny',
    status: 503,
    code: 'guard.session_stopped',
    reason: `session is stopped: ${session.stopped_reason}`,
  }
}

function groupBlocked({ policy, ctx }: GateInputs): GateResult {
  if (policy.groups.mode !== 'block' || !isGroupChatId(ctx.chatId)) return allow
  return {
    kind: 'deny',
    status: 403,
    code: 'guard.group_blocked',
    reason: 'policy refuses group sends from this session',
  }
}

function optOut({ policy, contact }: GateInputs): GateResult {
  if (!policy.optOut.enabled) return allow
  if (contact.state !== 'opted_out') return allow
  return {
    kind: 'deny',
    status: 403,
    code: 'guard.opted_out',
    reason: 'recipient opted out of messages from this number',
  }
}

function humanTouch(inputs: GateInputs): GateResult {
  const { policy, contact } = inputs
  if (!policy.contacts.requireHumanTouch) return allow
  if (groupExempt(inputs)) return allow
  if (contact.human_touch_at !== null) return allow
  return {
    kind: 'deny',
    status: 403,
    code: 'guard.no_human_touch',
    reason:
      'no human has ever messaged this contact from this number — send the first message by hand, then automation may follow',
  }
}

function handshake(inputs: GateInputs): GateResult {
  const { policy, contact } = inputs
  if (groupExempt(inputs)) return allow
  if (contact.in_count > 0) return allow
  if (contact.out_count < policy.contacts.handshakeMaxMessages) return allow
  return {
    kind: 'deny',
    status: 403,
    code: 'guard.handshake_exhausted',
    reason: `${contact.out_count} message(s) sent with no reply; limit is ${policy.contacts.handshakeMaxMessages}`,
  }
}

function strangerCap(inputs: GateInputs): GateResult {
  const { policy, store, ctx } = inputs
  const limit = policy.contacts.maxNewStrangersPerDay
  if (!Number.isFinite(limit)) return allow
  if (!opensAStranger(inputs)) return allow
  const cutoff = ctx.now - DAY
  if (store.countNewStrangersSince(ctx.session, cutoff) < limit) return allow
  const until = store.newStrangerSlotFreesAt(ctx.session, cutoff, limit, DAY)
  return {
    kind: 'wait',
    until: until ?? ctx.now + HOUR,
    code: 'guard.new_contact_budget',
    reason:
      `contacts.maxNewStrangersPerDay of ${limit}/day is spent — that budget counts only ` +
      `conversations this number started, not replies to people who messaged first`,
  }
}

function warmupBudget({ policy, store, session, ctx }: GateInputs): GateResult {
  const step = warmupStep(policy, session, ctx.now)
  if (!step) return allow
  const cutoff = ctx.now - DAY
  const sent = store.countSendsSince(ctx.session, cutoff)
  if (sent < step.maxPerDay) return allow
  const until = store.slotFreesAt(ctx.session, cutoff, step.maxPerDay, DAY)
  return {
    kind: 'wait',
    until: until ?? ctx.now + HOUR,
    code: 'guard.warmup_budget',
    reason: `warmup day budget of ${step.maxPerDay} messages is spent`,
  }
}

function warmupNewContacts(inputs: GateInputs): GateResult {
  const { policy, store, session, ctx } = inputs
  const step = warmupStep(policy, session, ctx.now)
  if (!step) return allow
  if (!opensAStranger(inputs)) return allow
  const cutoff = ctx.now - DAY
  if (store.countNewStrangersSince(ctx.session, cutoff) < step.maxNewContactsPerDay) return allow
  const until = store.newStrangerSlotFreesAt(ctx.session, cutoff, step.maxNewContactsPerDay, DAY)
  return {
    kind: 'wait',
    until: until ?? ctx.now + HOUR,
    code: 'guard.warmup_new_contacts',
    // Name the knob. This is a second, independent cap from `maxNewStrangersPerDay`, and a
    // preset sets it even when policy.yml never mentions `warmup` — so an operator who
    // raises the visible one and is refused again has no way to guess what just fired.
    reason:
      `warmup.schedule[fromDay: ${step.fromDay}].maxNewContactsPerDay of ` +
      `${step.maxNewContactsPerDay}/day is spent — a separate cap from ` +
      `contacts.maxNewStrangersPerDay, which the preset supplies when policy.yml omits ` +
      `warmup (see GET /_guard/status for the ramp in force)`,
  }
}

function timelock(inputs: GateInputs): GateResult {
  const { policy, session, ctx } = inputs
  if (!policy.timelock.enabled) return allow
  if (session.timelock_until === null || session.timelock_until <= ctx.now) return allow
  if (!policy.timelock.strangersBlockedWhileDegraded) return allow
  if (effectiveContactState(inputs) === 'known') return allow
  return {
    kind: 'wait',
    until: session.timelock_until,
    code: 'guard.degraded',
    reason: 'upstream signalled a rate limit; only replies to known contacts are going out',
  }
}

function replyRatio(inputs: GateInputs): GateResult {
  const { policy } = inputs
  if (!policy.replyRatio.enabled || policy.replyRatio.action === 'slow') return allow
  if (!replyRatioBreached(inputs)) return allow
  if (policy.replyRatio.action === 'block-strangers' && effectiveContactState(inputs) === 'known')
    return allow
  return {
    kind: 'deny',
    status: 429,
    code: 'guard.reply_ratio',
    reason: `sending more than ${policy.replyRatio.maxOutPerIn}x what is coming back over ${policy.replyRatio.windowHours}h`,
  }
}

function quietHours({ policy, ctx }: GateInputs): GateResult {
  const state = quietUntil(ctx.now, policy.quietHours)
  if (!state.quiet) return allow
  return {
    kind: 'wait',
    until: state.until,
    code: state.reason === 'quiet-day' ? 'guard.quiet_day' : 'guard.quiet_hours',
    reason: `quiet hours in ${policy.quietHours.timezone}`,
  }
}

function slidingWindows({ policy, store, ctx }: GateInputs): GateResult {
  const windows: [number, number, string][] = [
    [MINUTE, policy.rates.perMinute, 'minute'],
    [HOUR, policy.rates.perHour, 'hour'],
    [DAY, policy.rates.perDay, 'day'],
  ]
  for (const [windowMs, limit, name] of windows) {
    if (!Number.isFinite(limit)) continue
    const cutoff = ctx.now - windowMs
    if (store.countSendsSince(ctx.session, cutoff) < limit) continue
    const until = store.slotFreesAt(ctx.session, cutoff, limit, windowMs)
    return {
      kind: 'wait',
      until: until ?? ctx.now + windowMs,
      code: `guard.rate_${name}`,
      reason: `${limit} messages per ${name} reached`,
    }
  }
  return allow
}

function spacing(inputs: GateInputs): GateResult {
  const { store, ctx, policy } = inputs
  const last = store.lastSendAt(ctx.session)
  if (last === null) return allow
  const gap = policy.rates.minSpacingMs * spacingMultiplier(inputs) + ctx.jitterMs
  const until = last + gap
  if (until <= ctx.now) return allow
  return {
    kind: 'wait',
    until,
    code: 'guard.spacing',
    reason: `pacing: ${Math.round(gap / 1000)}s between messages`,
  }
}

/**
 * Order matters. Denials come first so a caller learns "never" before it learns "later" —
 * telling someone to retry in 40 minutes when the contact opted out is a worse answer.
 */
const GATES: ((inputs: GateInputs) => GateResult)[] = [
  sessionStopped,
  groupBlocked,
  optOut,
  humanTouch,
  handshake,
  replyRatio,
  timelock,
  quietHours,
  strangerCap,
  warmupNewContacts,
  warmupBudget,
  slidingWindows,
  spacing,
]

export function evaluate(inputs: GateInputs): GateResult {
  let latest: GateResult | null = null
  for (const gate of GATES) {
    const result = gate(inputs)
    if (result.kind === 'deny') return result
    if (
      result.kind === 'wait' &&
      (latest === null || result.until > (latest as { until: number }).until)
    ) {
      latest = result
    }
  }
  return latest ?? allow
}
