import type { SessionStateRow } from '../state/store.ts'
import { deepMerge } from './load.ts'
import type { SessionPolicy } from './schema.ts'

/**
 * Recovery after an outage, as a pure function of (policy, session state, now).
 *
 * The store records the length of the last qualifying stop and when it ended (see
 * `Store.setStopped`); everything here is derived from those two columns, so a guard
 * restart in the middle of a recovery window resumes it exactly where it was.
 */
export interface RecoveryState {
  active: boolean
  /** True inside the first `repliesOnlyForMs` of an active recovery. */
  repliesOnly: boolean
  resumedAt: number | null
  outageMs: number | null
  /** When the overlay stops applying; null when recovery is not active. */
  until: number | null
  /** When the replies-only window ends; null when recovery is not active. */
  repliesOnlyUntil: number | null
}

const INACTIVE: RecoveryState = {
  active: false,
  repliesOnly: false,
  resumedAt: null,
  outageMs: null,
  until: null,
  repliesOnlyUntil: null,
}

export function recoveryState(
  policy: SessionPolicy,
  session: Pick<SessionStateRow, 'last_outage_ms' | 'resumed_at'> | null,
  now: number,
): RecoveryState {
  const r = policy.recovery
  if (!r.enabled || !session) return INACTIVE
  const { last_outage_ms: outageMs, resumed_at: resumedAt } = session
  if (outageMs === null || resumedAt === null) return INACTIVE
  if (outageMs < r.afterOfflineMs) return INACTIVE
  const elapsed = now - resumedAt
  if (elapsed < 0 || elapsed >= r.durationMs) return { ...INACTIVE, resumedAt, outageMs }
  return {
    active: true,
    repliesOnly: elapsed < r.repliesOnlyForMs,
    resumedAt,
    outageMs,
    until: resumedAt + r.durationMs,
    repliesOnlyUntil: resumedAt + r.repliesOnlyForMs,
  }
}

/** The session policy with `recovery.overlay` deep-merged on top while recovery is active. */
export function applyRecovery(
  policy: SessionPolicy,
  session: Pick<SessionStateRow, 'last_outage_ms' | 'resumed_at'> | null,
  now: number,
): SessionPolicy {
  if (!recoveryState(policy, session, now).active) return policy
  // `recovery` itself is never overlaid: validation refuses it, and the window that decides
  // whether the overlay applies must not be moved by the overlay.
  const { recovery: _ignored, ...overlay } = policy.recovery.overlay as Record<string, unknown>
  return { ...deepMerge(policy, overlay), recovery: policy.recovery }
}
