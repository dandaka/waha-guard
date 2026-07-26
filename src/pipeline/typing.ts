import type { TypingPolicy } from '../policy/schema.ts'
import { clamp, defaultRng, gaussian, type Rng, uniform } from '../util/random.ts'

/**
 * Typing indicators that match the message.
 *
 * The defect this replaces: a fixed delay per message, or a "WPM" figure of 240–420 that
 * nobody types at — a 300-character message finished in under two seconds while the
 * indicator claimed a human was typing it. Here the duration is drawn from a plausible
 * WPM distribution and the indicator actually runs for that long.
 */

export interface TypingStep {
  kind: 'composing' | 'paused'
  durationMs: number
}

export interface TypingPlan {
  /** The words-per-minute actually drawn for this message. */
  wpm: number
  /** Sum of composing steps — what the WPM model asked for, after the cap. */
  composingMs: number
  /** Wall-clock duration of the whole plan, pauses included. */
  totalMs: number
  steps: TypingStep[]
  /** True when maxPlanMs truncated the plan. */
  capped: boolean
}

export function planTyping(
  textLength: number,
  policy: TypingPolicy,
  rng: Rng = defaultRng,
): TypingPlan {
  const empty: TypingPlan = { wpm: 0, composingMs: 0, totalMs: 0, steps: [], capped: false }
  if (!policy.enabled || textLength <= 0) return empty

  const wpm = clamp(gaussian(policy.wpmMean, policy.wpmStddev, rng), policy.wpmMin, policy.wpmMax)
  const words = textLength / policy.charsPerWord
  const idealMs = Math.round((words / wpm) * 60_000)
  const composingMs = Math.min(idealMs, policy.maxPlanMs)
  if (composingMs <= 0) return empty

  const steps: TypingStep[] = []
  let remaining = composingMs
  let total = 0
  while (remaining > 0) {
    // Bursts are capped at refreshMs because WhatsApp expires a `composing` presence
    // server-side; a longer burst would show the indicator visibly lapsing. maxPlanMs
    // bounds the whole plan, pauses included — it is what stops a long message from
    // holding a `block`-mode HTTP request open past its deadline.
    const burst = Math.min(remaining, policy.refreshMs, policy.maxPlanMs - total)
    if (burst <= 0) break
    steps.push({ kind: 'composing', durationMs: burst })
    remaining -= burst
    total += burst
    if (remaining > 0) {
      const pause = Math.round(uniform(policy.pauseMinMs, policy.pauseMaxMs, rng))
      if (total + pause >= policy.maxPlanMs) break
      steps.push({ kind: 'paused', durationMs: pause })
      total += pause
    }
  }

  return {
    wpm,
    composingMs: steps.filter((s) => s.kind === 'composing').reduce((a, s) => a + s.durationMs, 0),
    totalMs: total,
    steps,
    capped: idealMs > policy.maxPlanMs,
  }
}
