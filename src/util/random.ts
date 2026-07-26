/** Injectable so the pacing and typing tests are deterministic rather than flaky. */
export type Rng = () => number

export const defaultRng: Rng = Math.random

/** Box–Muller. Truncated at ±`clamp` σ so a tail draw cannot produce an absurd delay. */
export function gaussian(mean: number, stddev: number, rng: Rng = defaultRng, clamp = 2): number {
  if (stddev <= 0) return mean
  const u1 = Math.max(rng(), Number.EPSILON)
  const u2 = rng()
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  return mean + stddev * Math.max(-clamp, Math.min(clamp, z))
}

export function uniform(min: number, max: number, rng: Rng = defaultRng): number {
  return min + (max - min) * rng()
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
