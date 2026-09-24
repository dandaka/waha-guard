/**
 * Replay the September 20–21 send history through the re-engagement gates.
 *
 * Pass a consistent snapshot of the production guard SQLite database. The source is opened
 * read-only; all replay state is in memory. Output is aggregate counts only. Inbound events
 * that occurred during the wave are replayed even if a counterfactual refusal would have
 * prevented the send that prompted them, so the result is a historical gate check rather
 * than a prediction of subsequent conversation behavior.
 *
 * Usage: bun scripts/replay-2026-09-wave.ts /path/to/guard-snapshot.sqlite
 */
import { Database } from 'bun:sqlite'
import { evaluate } from '../src/pipeline/gates.ts'
import { presetPolicy } from '../src/policy/schema.ts'
import { Store } from '../src/state/store.ts'

const snapshotPath = Bun.argv[2]
if (!snapshotPath) throw new Error('pass a guard SQLite snapshot path')

const source = new Database(snapshotPath, { readonly: true })
const replay = new Store(':memory:')
const from = Date.parse('2026-09-19T23:00:00Z') // September 20, Lisbon midnight
const to = Date.parse('2026-09-21T23:00:00Z') // September 22, Lisbon midnight
const policy = presetPolicy('off')
policy.contacts.requireHumanTouch = true
policy.contacts.dormantAfterDays = 7
policy.contacts.maxReengagementsPerDay = 5
policy.contacts.handshakeMaxMessages = 1
policy.quietHours.timezone = 'Europe/Lisbon'

interface Event {
  kind: 'send' | 'inbound'
  id: number
  session: string
  chat_id: string
  at: number
  origin: 'guard' | 'human' | null
}

const events = source
  .query(
    `SELECT 'send' kind, id, session, chat_id, sent_at at, origin FROM sends
     WHERE sent_at >= ? AND sent_at < ?
     UNION ALL
     SELECT 'inbound', id, session, chat_id, at, NULL FROM inbound
     WHERE at >= ? AND at < ?
     ORDER BY at, kind`,
  )
  .all(from, to, from, to) as Event[]
const preInbound = source.query('SELECT MAX(at) at FROM inbound WHERE session=? AND chat_id=? AND at<?')
const preTouch = source.query('SELECT human_touch_at at FROM contacts WHERE session=? AND chat_id=?')
const seeded = new Set<string>()
type Counts = {
  attempted: number
  allowed: number
  reengagementBudget: number
  handshake: number
  other: number
  human: number
}
const summaries = new Map<string, Counts>()
const day = (at: number) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at)

for (const event of events) {
  const key = `${event.session}|${event.chat_id}`
  if (!seeded.has(key)) {
    seeded.add(key)
    const touch = (preTouch.get(event.session, event.chat_id) as { at: number | null } | null)?.at
    if (touch != null && touch < from)
      replay.markHumanTouch(event.session, event.chat_id, from, touch)
    const inbound = (
      preInbound.get(event.session, event.chat_id, from) as { at: number | null }
    ).at
    if (inbound != null) replay.recordInbound(event.session, event.chat_id, `pre-${key}`, inbound)
  }

  if (event.kind === 'inbound') {
    replay.recordInbound(event.session, event.chat_id, `in-${event.id}`, event.at)
    continue
  }

  const summaryKey = `${event.session}|${day(event.at)}`
  let counts = summaries.get(summaryKey)
  if (!counts) {
    counts = { attempted: 0, allowed: 0, reengagementBudget: 0, handshake: 0, other: 0, human: 0 }
    summaries.set(summaryKey, counts)
  }
  if (event.origin === 'human') {
    counts.human++
    replay.recordHumanOutbound(event.session, event.chat_id, `human-${event.id}`, event.at)
    continue
  }

  counts.attempted++
  const contact = replay.ensureContact(event.session, event.chat_id, event.at)
  const result = evaluate({
    policy,
    store: replay,
    contact,
    session: replay.ensureSession(event.session, event.at),
    ctx: {
      session: event.session,
      chatId: event.chat_id,
      route: 'sendText',
      textLength: 0,
      now: event.at,
      jitterMs: 0,
      force: false,
    },
  }).result
  if (result.kind === 'allow') {
    counts.allowed++
    replay.recordGuardOutbound(event.session, event.chat_id, 'sendText', `guard-${event.id}`, event.at)
  } else if (result.code === 'guard.reengagement_budget') counts.reengagementBudget++
  else if (result.code === 'guard.handshake_exhausted') counts.handshake++
  else counts.other++
}

for (const [sessionDay, counts] of summaries) console.log(JSON.stringify({ sessionDay, ...counts }))
replay.close()
source.close()
