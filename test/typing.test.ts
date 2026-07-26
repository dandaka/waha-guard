import { describe, expect, test } from 'bun:test'
import { planTyping } from '../src/pipeline/typing.ts'
import { presetPolicy } from '../src/policy/schema.ts'

const typing = presetPolicy('conservative').typing
/** Median draw: gaussian() returns the mean, uniform() returns the midpoint. */
const median = () => 0.5

describe('typing plans', () => {
  test('indicator duration matches the sampled WPM within 10%', () => {
    const policy = { ...typing, maxPlanMs: 10 * 60_000 }
    for (const length of [20, 100, 300, 900]) {
      const plan = planTyping(length, policy, median)
      const expectedMs = (length / policy.charsPerWord / plan.wpm) * 60_000
      expect(Math.abs(plan.composingMs - expectedMs) / expectedMs).toBeLessThan(0.1)
    }
  })

  test('the drawn WPM is a rate a person could actually type at', () => {
    const samples = Array.from({ length: 200 }, () => planTyping(200, typing, Math.random).wpm)
    for (const wpm of samples) {
      expect(wpm).toBeGreaterThanOrEqual(typing.wpmMin)
      expect(wpm).toBeLessThanOrEqual(typing.wpmMax)
    }
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length
    expect(Math.abs(mean - typing.wpmMean)).toBeLessThan(6)
  })

  test('no burst outlives the server-side presence expiry', () => {
    const plan = planTyping(2000, { ...typing, maxPlanMs: 10 * 60_000 }, median)
    for (const step of plan.steps) {
      if (step.kind === 'composing') expect(step.durationMs).toBeLessThanOrEqual(typing.refreshMs)
    }
    expect(plan.steps.filter((s) => s.kind === 'composing').length).toBeGreaterThan(1)
  })

  test('long messages get pauses between bursts, short ones do not', () => {
    const long = planTyping(2000, { ...typing, maxPlanMs: 10 * 60_000 }, median)
    expect(long.steps.some((s) => s.kind === 'paused')).toBe(true)
    const short = planTyping(10, typing, median)
    expect(short.steps).toHaveLength(1)
    expect(short.steps[0]!.kind).toBe('composing')
  })

  test('a plan never exceeds maxPlanMs, however long the message', () => {
    const plan = planTyping(100_000, typing, median)
    expect(plan.totalMs).toBeLessThanOrEqual(typing.maxPlanMs)
    expect(plan.capped).toBe(true)
  })

  test('disabled typing and empty text produce no plan', () => {
    expect(planTyping(500, { ...typing, enabled: false }, median).steps).toHaveLength(0)
    expect(planTyping(0, typing, median).steps).toHaveLength(0)
  })

  test('the old fixed-rate defect would fail this: 300 chars is not a 2-second message', () => {
    const plan = planTyping(300, { ...typing, maxPlanMs: 10 * 60_000 }, median)
    expect(plan.composingMs).toBeGreaterThan(30_000)
  })
})
