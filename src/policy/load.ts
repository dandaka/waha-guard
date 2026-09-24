import {
  type DeepPartial,
  type Policy,
  PRESETS,
  type PresetName,
  presetPolicy,
  type SessionPolicy,
} from './schema.ts'

export class PolicyError extends Error {}

const PRESET_NAMES = Object.keys(PRESETS) as PresetName[]

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Deep-merge `patch` over `base`. Arrays replace wholesale — a partial array merge is
 * never what anyone means for a warmup schedule or a keyword list.
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return base
  if (!isPlainObject(base)) return patch as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value)
      ? deepMerge((base as Record<string, unknown>)[key], value)
      : value
  }
  return out as T
}

/** `null` in YAML means "no limit" for numeric caps; it reads better than 1e9. */
function normalizeUnlimited(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(normalizeUnlimited)
  if (!isPlainObject(node)) return node === null ? Number.POSITIVE_INFINITY : node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node)) out[k] = normalizeUnlimited(v)
  return out
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/

function validate(p: Policy): void {
  const problems: string[] = []
  const check = (scope: string, s: SessionPolicy) => {
    if (s.quietHours.enabled) {
      for (const [field, value] of [
        ['start', s.quietHours.start],
        ['end', s.quietHours.end],
      ] as const) {
        if (!TIME_RE.test(value))
          problems.push(
            `${scope}.quietHours.${field}: expected HH:MM, got ${JSON.stringify(value)}`,
          )
      }
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: s.quietHours.timezone })
      } catch {
        problems.push(
          `${scope}.quietHours.timezone: unknown IANA zone ${JSON.stringify(s.quietHours.timezone)}`,
        )
      }
    }
    if (s.rates.minSpacingMs < 0) problems.push(`${scope}.rates.minSpacingMs must be >= 0`)
    if (s.rates.jitterStddevMs < 0) problems.push(`${scope}.rates.jitterStddevMs must be >= 0`)
    if (!Number.isFinite(s.contacts.dormantAfterDays) || s.contacts.dormantAfterDays <= 0)
      problems.push(`${scope}.contacts.dormantAfterDays must be a positive number`)
    if (s.contacts.maxReengagementsPerDay < 0)
      problems.push(`${scope}.contacts.maxReengagementsPerDay must be >= 0`)
    if (s.backpressure.maxWaitMs <= 0) problems.push(`${scope}.backpressure.maxWaitMs must be > 0`)
    if (s.typing.enabled) {
      if (s.typing.wpmMin <= 0) problems.push(`${scope}.typing.wpmMin must be > 0`)
      if (s.typing.wpmMax < s.typing.wpmMin)
        problems.push(`${scope}.typing.wpmMax must be >= wpmMin`)
      if (s.typing.refreshMs <= 0) problems.push(`${scope}.typing.refreshMs must be > 0`)
      if (s.typing.pauseMaxMs < s.typing.pauseMinMs)
        problems.push(`${scope}.typing.pauseMaxMs must be >= pauseMinMs`)
    }
    if (s.sessionHealth.poll.enabled && s.sessionHealth.poll.intervalMs <= 0)
      problems.push(`${scope}.sessionHealth.poll.intervalMs must be > 0`)
    if (s.sessionHealth.recheckMs <= 0)
      problems.push(`${scope}.sessionHealth.recheckMs must be > 0`)
    if (s.sessionHealth.transientGraceMs < 0)
      problems.push(`${scope}.sessionHealth.transientGraceMs must be >= 0`)
    if (s.sessionHealth.autoRestart.enabled && s.sessionHealth.autoRestart.cooldownMs <= 0)
      problems.push(`${scope}.sessionHealth.autoRestart.cooldownMs must be > 0`)
    if (s.warmup.enabled) {
      if (s.warmup.schedule.length === 0)
        problems.push(`${scope}.warmup.schedule must not be empty`)
      let prev = Number.NEGATIVE_INFINITY
      for (const step of s.warmup.schedule) {
        if (step.fromDay < prev) problems.push(`${scope}.warmup.schedule must be sorted by fromDay`)
        prev = step.fromDay
      }
    }
    if (s.presence === 'guard' && !s.typing.enabled) {
      // Not an error: owning presence without a typing plan just means the guard suppresses
      // nothing and sends nothing. Worth saying out loud though.
      console.warn(
        `[policy] ${scope}: presence=guard but typing.enabled=false — no indicators will be sent`,
      )
    }
  }
  check('policy', p)
  for (const [name, override] of Object.entries(p.sessions)) {
    check(`policy.sessions.${name}`, deepMerge(p, override) as SessionPolicy)
  }
  if (problems.length > 0) throw new PolicyError(`invalid policy:\n  - ${problems.join('\n  - ')}`)
}

/** Parse a policy document (already-parsed YAML/JSON) into a validated Policy. */
export function fromDocument(doc: unknown): Policy {
  if (doc === null || doc === undefined) return presetPolicy('conservative')
  if (!isPlainObject(doc)) throw new PolicyError('policy file must be a YAML mapping')

  const raw = normalizeUnlimited(doc) as Record<string, unknown>
  const presetName = (raw.preset ?? 'conservative') as PresetName
  if (!PRESET_NAMES.includes(presetName)) {
    throw new PolicyError(
      `unknown preset ${JSON.stringify(presetName)}; expected one of ${PRESET_NAMES.join(', ')}`,
    )
  }

  const { preset: _preset, sessions, ...rest } = raw
  const base = presetPolicy(presetName)
  const merged = deepMerge(base, rest) as Policy
  merged.preset = presetName
  merged.sessions = (sessions ?? {}) as Record<string, DeepPartial<SessionPolicy>>
  if (!isPlainObject(merged.sessions))
    throw new PolicyError('policy.sessions must be a mapping of session name to overrides')

  validate(merged)
  return merged
}

export async function loadPolicyFile(path: string): Promise<Policy> {
  const file = Bun.file(path)
  if (!(await file.exists())) throw new PolicyError(`policy file not found: ${path}`)
  const text = await file.text()
  let doc: unknown
  try {
    doc = Bun.YAML.parse(text)
  } catch (err) {
    throw new PolicyError(`could not parse ${path}: ${(err as Error).message}`)
  }
  return fromDocument(doc)
}

/** The effective policy for one session: base policy with that session's overrides applied. */
export function forSession(policy: Policy, session: string): SessionPolicy {
  const override = policy.sessions[session]
  const { sessions: _s, preset: _p, ...base } = policy
  return override
    ? (deepMerge(base as SessionPolicy, override) as SessionPolicy)
    : (base as SessionPolicy)
}
