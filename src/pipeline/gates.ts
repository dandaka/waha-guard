import type { ContactState, SessionPolicy } from '../policy/schema.ts'
import type { ContactRow, SessionStateRow, Store } from '../state/store.ts'
import {
  DAY,
  HOUR,
  MINUTE,
  quietUntil,
  startOfNextZonedDay,
  startOfZonedDay,
} from '../util/time.ts'
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
  /**
   * An operator-approved override for this one send. Skips the pacing and volume gates
   * listed as `forceable` in GATES; never consent, never a safety stop. Per-request and
   * never persisted — see `forceable` below and README "Forcing one send past a limit".
   */
  force: boolean
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

/**
 * Statuses a session can come back from on its own, in seconds, without anybody doing
 * anything. `FAILED` and `SCAN_QR_CODE` are deliberately absent: they are the shape of an
 * account action, and riding one out would mean sitting quietly through an unlink.
 */
const TRANSIENT_STOP_STATUSES = new Set(['STOPPED', 'STARTING'])

/**
 * A stopped session cannot send — but "stopped" covers two different things.
 *
 * A gows websocket drop stops the session and reconnects a second or two later. Refusing
 * outright there destroys a message over a blip: on 2026-07-29 six such flaps cost two real
 * sends, both of which would have gone out had the guard waited three seconds. Inside the
 * grace window this is a `wait`, so `backpressure: block` rides it out and the poller's next
 * read clears the stop underneath the waiting send.
 *
 * Past the grace window it is a denial again, and quickly. A caller that waits out the full
 * backpressure budget on every request during a real outage learns nothing and blocks its
 * own queue; a 503 tells it the truth.
 */
function sessionStopped({ session, policy, ctx }: GateInputs): GateResult {
  if (!session.stopped_reason) return allow

  const transient =
    session.stopped_status !== null && TRANSIENT_STOP_STATUSES.has(session.stopped_status)
  const stoppedFor = session.stopped_since === null ? null : ctx.now - session.stopped_since
  if (transient && stoppedFor !== null && stoppedFor < policy.sessionHealth.transientGraceMs) {
    return {
      kind: 'wait',
      until: ctx.now + policy.sessionHealth.recheckMs,
      code: 'guard.session_reconnecting',
      reason: `session is reconnecting (${session.stopped_status}, ${Math.round(stoppedFor / 1000)}s)`,
    }
  }

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
      'this contact has never messaged, called or otherwise engaged with this number, and no ' +
      'human has written to them from it — send the first message by hand, then automation may follow',
  }
}

function isDormant(inputs: GateInputs): boolean {
  const { contact, ctx, policy } = inputs
  return (
    !groupExempt(inputs) &&
    contact.last_in_at !== null &&
    (contact.in_count > 0 || contact.human_touch_at !== null) &&
    contact.last_in_at <= ctx.now - policy.contacts.dormantAfterDays * DAY
  )
}

function reengagementBudget(inputs: GateInputs): GateResult {
  if (!isDormant(inputs)) return allow
  const { policy, store, ctx } = inputs
  const since = startOfZonedDay(ctx.now, policy.quietHours.timezone)
  // A contact consumes only their first slot today. The handshake gate controls repeats.
  if (store.countSendsToContactSince(ctx.session, ctx.chatId, since) > 0) return allow
  const limit = policy.contacts.maxReengagementsPerDay
  if (!Number.isFinite(limit)) return allow
  const spent = store.countDormantContactsMessagedSince(
    ctx.session,
    since,
    policy.contacts.dormantAfterDays * DAY,
    policy.groups.mode === 'exempt',
  )
  if (spent < limit) return allow
  return {
    kind: 'deny',
    status: 403,
    code: 'guard.reengagement_budget',
    reason:
      `contacts.maxReengagementsPerDay of ${limit}/day is spent for ${ctx.session}; ` +
      `dormant contacts are not queued for a later day`,
  }
}

/**
 * How many unanswered messages may go to one contact — **per day**, not ever.
 *
 * It used to be per lifetime, read off `contacts.out_count`. That made the cap permanent:
 * a contact who had not replied was muted until they wrote in first, and on 2026-07-27 a
 * Monday follow-up to an employer was refused because the message before it went out on
 * the Sunday. One unanswered message is not a rejection; one unanswered message *today* is
 * as far as we should push in a day.
 *
 * The day is a calendar day in `quietHours.timezone`, deliberately reusing the zone quiet
 * hours already resolves rather than introducing a second notion of "day" — the whole point
 * is the recipient's day, and a rolling 24h window would refuse a 09:00 follow-up because
 * yesterday's went out at 10:00. The zone is read even when quiet hours are disabled; it is
 * the session's timezone, and quiet hours are just its other consumer.
 *
 * A conversation that crosses midnight counts as two days by this gate and one by any human
 * reading the thread. That is accepted rather than solved: quiet hours (22:00–08:00 Lisbon)
 * mean the only traffic that can straddle the boundary is traffic we already refuse, and a
 * cleverer rule would be untestable for a case that cannot occur.
 *
 * This stays a `deny`, not a `wait`. A `wait` would park the message and fire it when the
 * day rolls over, which is a queue of messages waiting on a clock — the shape that was
 * deleted on 2026-07-25. The reason line names the date instead, so the caller can decide.
 */
function handshake(inputs: GateInputs): GateResult {
  const { policy, store, contact, ctx } = inputs
  if (groupExempt(inputs)) return allow
  if (contact.in_count > 0 && !isDormant(inputs)) return allow
  const timezone = policy.quietHours.timezone
  const sentToday = store.countSendsToContactSince(
    ctx.session,
    ctx.chatId,
    startOfZonedDay(ctx.now, timezone),
  )
  if (sentToday < policy.contacts.handshakeMaxMessages) return allow
  const resets = new Date(startOfNextZonedDay(ctx.now, timezone)).toISOString()
  return {
    kind: 'deny',
    status: 403,
    code: 'guard.handshake_exhausted',
    reason:
      `${sentToday} message(s) sent today with no reply; limit is ` +
      `${policy.contacts.handshakeMaxMessages} per day (${contact.out_count} sent in total). ` +
      `Resets at ${resets} — ${timezone} midnight.`,
  }
}

/**
 * Groups are outside the contact gates when `groups.mode` is `exempt`, so they are outside
 * the counter too. A gate that never refuses a group send while the counter charges every
 * one of them just spends the whole budget on chats it was not protecting: 20 job posts to
 * community groups read as 20 strangers cold-messaged, and the next real person is refused.
 */
export function countsNewStrangers(
  policy: SessionPolicy,
  store: Store,
  session: string,
  now: number,
) {
  const excludeGroups = policy.groups.mode === 'exempt'
  const cutoff = now - DAY
  return {
    spent: store.countNewStrangersSince(session, cutoff, excludeGroups),
    slotFreesAt: (limit: number) =>
      store.newStrangerSlotFreesAt(session, cutoff, limit, DAY, excludeGroups),
  }
}

function strangerCap(inputs: GateInputs): GateResult {
  const { policy, store, ctx } = inputs
  const limit = policy.contacts.maxNewStrangersPerDay
  if (!Number.isFinite(limit)) return allow
  if (!opensAStranger(inputs)) return allow
  const budget = countsNewStrangers(policy, store, ctx.session, ctx.now)
  if (budget.spent < limit) return allow
  const until = budget.slotFreesAt(limit)
  return {
    kind: 'wait',
    until: until ?? ctx.now + HOUR,
    code: 'guard.new_contact_budget',
    reason:
      `contacts.maxNewStrangersPerDay of ${limit}/day is spent — that budget counts only ` +
      `conversations this number started, not replies to people who messaged first`,
  }
}

/**
 * The warmup ramp teaches a young number to talk to *people* at a human volume, and
 * `groups.mode: exempt` says a community group is not one of those conversations — the same
 * reasoning `countsNewStrangers` already applies to the new-contact half of the ramp.
 *
 * Counting group posts here spent the ramp on traffic the ramp would never have refused: on
 * 2026-07-27 a morning of job posts to community groups took the whole day-0 budget of 20
 * before noon, and the chase to the one employer we had a live mandate with was refused with
 * `guard.warmup_budget`. `rates.perDay` still counts every send, groups included, so the
 * number keeps a hard ceiling on what it puts on the wire.
 */
function warmupBudget({ policy, store, session, ctx }: GateInputs): GateResult {
  const step = warmupStep(policy, session, ctx.now)
  if (!step) return allow
  const excludeGroups = policy.groups.mode === 'exempt'
  const cutoff = ctx.now - DAY
  const sent = store.countSendsSince(ctx.session, cutoff, excludeGroups)
  if (sent < step.maxPerDay) return allow
  const until = store.slotFreesAt(ctx.session, cutoff, step.maxPerDay, DAY, excludeGroups)
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
  const budget = countsNewStrangers(policy, store, ctx.session, ctx.now)
  if (budget.spent < step.maxNewContactsPerDay) return allow
  const until = budget.slotFreesAt(step.maxNewContactsPerDay)
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

interface Gate {
  run: (inputs: GateInputs) => GateResult
  /**
   * May an operator-approved `force` skip this gate?
   *
   * The line is: `force` overrides **our own pacing and volume budgets**, which are guesses
   * we wrote down. It never overrides consent, a human's deliberate decision, or a signal
   * coming from outside the guard.
   *
   *  - `optOut` — consent. `CLAUDE.md` in the calling project is unambiguous and so is this:
   *    nothing overrides an opt-out, and a flag that could would make every other guarantee
   *    conditional.
   *  - `sessionStopped` — a safety stop, set because something went wrong. Forcing past it
   *    is forcing past the alarm rather than the fire.
   *  - `humanTouch` — the relationship control. Skipping it turns `force` into a cold-outreach
   *    switch, which is the exact behaviour that got a number unlinked on 2026-07-25.
   *  - `groupBlocked` — a policy statement that this session does not post to groups. Not a
   *    budget that ran out.
   *  - `timelock` — WhatsApp itself is rate-limiting us. This is the one gate whose input is
   *    the platform's opinion, and pushing through it is how a number dies.
   *  - `quietHours` — a 03:00 message is not worth forcing. It is also self-resolving: the
   *    send goes at 08:00 on its own. Decided explicitly, not by omission.
   *  - `spacing` — seconds, not a day, and it self-resolves inside `maxWaitMs`. The cheapest
   *    anti-ban behaviour there is; there is nothing to gain by skipping it.
   */
  forceable: boolean
}

/**
 * Order matters. Denials come first so a caller learns "never" before it learns "later" —
 * telling someone to retry in 40 minutes when the contact opted out is a worse answer.
 */
const GATES: Gate[] = [
  { run: sessionStopped, forceable: false },
  { run: groupBlocked, forceable: false },
  { run: optOut, forceable: false },
  { run: humanTouch, forceable: false },
  { run: handshake, forceable: true },
  { run: reengagementBudget, forceable: true },
  { run: replyRatio, forceable: true },
  { run: timelock, forceable: false },
  { run: quietHours, forceable: false },
  { run: strangerCap, forceable: true },
  { run: warmupNewContacts, forceable: true },
  { run: warmupBudget, forceable: true },
  { run: slidingWindows, forceable: true },
  { run: spacing, forceable: false },
]

export interface GateEvaluation {
  result: GateResult
  /**
   * Reason codes of the gates a `force` actually overrode — gates that would have refused
   * this send. Empty when `ctx.force` is false, and empty when force was requested but
   * nothing was in the way. The caller logs these: an override nobody can find afterwards
   * is a hole in the only audit trail we have for sends that bypass the mailbox.
   */
  forced: string[]
}

export function evaluate(inputs: GateInputs): GateEvaluation {
  let latest: GateResult | null = null
  const forced: string[] = []
  for (const gate of GATES) {
    const result = gate.run(inputs)
    if (inputs.ctx.force && gate.forceable) {
      // Run it anyway and report only the gates that would have said no, so the audit line
      // names the limit that was actually overridden rather than every gate force may touch.
      if (result.kind !== 'allow') forced.push(result.code)
      continue
    }
    if (result.kind === 'deny') return { result, forced }
    if (
      result.kind === 'wait' &&
      (latest === null || result.until > (latest as { until: number }).until)
    ) {
      latest = result
    }
  }
  return { result: latest ?? allow, forced }
}
