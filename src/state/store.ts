import { Database } from 'bun:sqlite'
import type { ContactState } from '../policy/schema.ts'
import { normalizeChatId } from '../waha/identity.ts'

/**
 * Durable guard state.
 *
 * Durability is not optional: an in-memory guard resets every warmup counter and contact
 * state on restart, which turns a 14-day warmup ramp into a permanent day-0 ramp and
 * silently forgets who has opted out.
 *
 * Sliding-window budgets are computed from the `sends` table (COUNT WHERE sent_at > cutoff),
 * never stored as per-window counters. A stored counter keyed by window is a *fixed* window
 * that resets at the boundary, which lets a caller send 2x the cap across a boundary.
 *
 * Every chat id that crosses this boundary is resolved to a single identity first (see
 * `resolveChatId`). That is deliberately the *only* place it happens: one person arriving as
 * both `@lid` and `@c.us` must be one contact to every gate, counter and window, and a rule
 * enforced at one choke point cannot be forgotten at a call site.
 */

export interface ContactRow {
  session: string
  chat_id: string
  state: ContactState
  first_seen: number
  last_out_at: number | null
  last_in_at: number | null
  human_touch_at: number | null
  out_count: number
  in_count: number
  opted_out_at: number | null
}

export interface SendRow {
  id: number
  session: string
  chat_id: string
  msg_id: string | null
  sent_at: number
  ack: number | null
  ack_at: number | null
  route: string
  origin: 'guard' | 'human'
}

export interface QueuedRow {
  guard_id: string
  session: string
  chat_id: string
  route: string
  method: string
  path: string
  /** JSON array of [name, value] pairs — the caller's headers, replayed on send. */
  headers: string
  body: Uint8Array
  text_length: number
  enqueued_at: number
  not_before: number
  attempts: number
  state: 'pending' | 'sent' | 'dropped'
  last_error: string | null
}

export interface SessionStateRow {
  session: string
  mode: string
  warmup_started_at: number
  timelock_until: number | null
  rate_multiplier: number
  multiplier_set_at: number | null
  stopped_reason: string | null
}

const MIGRATIONS: string[] = [
  `CREATE TABLE contacts (
     session         TEXT NOT NULL,
     chat_id         TEXT NOT NULL,
     state           TEXT NOT NULL,
     first_seen      INTEGER NOT NULL,
     last_out_at     INTEGER,
     last_in_at      INTEGER,
     human_touch_at  INTEGER,
     out_count       INTEGER NOT NULL DEFAULT 0,
     in_count        INTEGER NOT NULL DEFAULT 0,
     opted_out_at    INTEGER,
     PRIMARY KEY (session, chat_id)
   );
   CREATE TABLE sends (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     session  TEXT NOT NULL,
     chat_id  TEXT NOT NULL,
     msg_id   TEXT,
     sent_at  INTEGER NOT NULL,
     ack      INTEGER,
     ack_at   INTEGER,
     route    TEXT NOT NULL,
     origin   TEXT NOT NULL DEFAULT 'guard'
   );
   CREATE INDEX sends_session_time ON sends (session, sent_at);
   CREATE INDEX sends_msg_id ON sends (msg_id);
   CREATE TABLE inbound (
     id       INTEGER PRIMARY KEY AUTOINCREMENT,
     session  TEXT NOT NULL,
     chat_id  TEXT NOT NULL,
     msg_id   TEXT,
     at       INTEGER NOT NULL
   );
   CREATE INDEX inbound_session_time ON inbound (session, at);
   CREATE UNIQUE INDEX inbound_msg_id ON inbound (msg_id) WHERE msg_id IS NOT NULL;
   CREATE TABLE queued (
     guard_id     TEXT PRIMARY KEY,
     session      TEXT NOT NULL,
     chat_id      TEXT NOT NULL,
     route        TEXT NOT NULL,
     method       TEXT NOT NULL,
     path         TEXT NOT NULL,
     headers      TEXT NOT NULL,
     body         BLOB NOT NULL,
     text_length  INTEGER NOT NULL,
     enqueued_at  INTEGER NOT NULL,
     not_before   INTEGER NOT NULL DEFAULT 0,
     attempts     INTEGER NOT NULL DEFAULT 0,
     state        TEXT NOT NULL DEFAULT 'pending',
     last_error   TEXT
   );
   CREATE INDEX queued_pending ON queued (state, session, not_before);
   CREATE TABLE session_state (
     session            TEXT PRIMARY KEY,
     mode               TEXT NOT NULL DEFAULT 'normal',
     warmup_started_at  INTEGER NOT NULL,
     timelock_until     INTEGER,
     rate_multiplier    REAL NOT NULL DEFAULT 1,
     multiplier_set_at  INTEGER,
     stopped_reason     TEXT
   );`,
  // Alternative spellings of one person: `<lid>@lid` -> `<phone>@c.us`.
  `CREATE TABLE contact_aliases (
     session    TEXT NOT NULL,
     alias      TEXT NOT NULL,
     chat_id    TEXT NOT NULL,
     linked_at  INTEGER NOT NULL,
     PRIMARY KEY (session, alias)
   );
   CREATE INDEX contact_aliases_target ON contact_aliases (session, chat_id);`,
]

const STATE_RANK: Record<ContactState, number> = {
  stranger: 0,
  handshake_sent: 1,
  known: 2,
  opted_out: 3,
}

/** The earlier of two timestamps, ignoring nulls — "when did this start". */
function earliest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

/** The later of two timestamps, ignoring nulls — "when did this last happen". */
function latest(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.max(a, b)
}

export class Store {
  readonly db: Database

  constructor(path: string) {
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.migrate()
  }

  private migrate(): void {
    const current = (this.db.query('PRAGMA user_version').get() as { user_version: number })
      .user_version
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v + 1}`)
      })()
    }
  }

  close(): void {
    this.db.close()
  }

  // ---- identity -----------------------------------------------------------

  /**
   * The identity a chat id belongs to: folded to one spelling, then followed through any
   * LID link the guard has learned. Every contact-keyed method below starts here, so a
   * reply that arrives as `@lid` and a send addressed to `@c.us` reach the same row.
   *
   * An unresolved `@lid` returns itself. That is the honest answer — the person is real and
   * their messages must still be recorded — and `linkIdentity` folds those rows in later.
   */
  resolveChatId(session: string, chatId: string): string {
    const normalized = normalizeChatId(chatId)
    const row = this.db
      .query('SELECT chat_id FROM contact_aliases WHERE session = ? AND alias = ?')
      .get(session, normalized) as { chat_id: string } | null
    return row?.chat_id ?? normalized
  }

  /**
   * Learn that `alias` is another name for `chatId`, and fold everything already recorded
   * under the alias into it.
   *
   * The fold is what makes late resolution safe: a reply booked against a bare `@lid` before
   * the phone was known still ends up credited to the contact, so the handshake clears
   * retroactively rather than staying stuck on a technicality.
   *
   * Returns false when the link was already known.
   */
  linkIdentity(session: string, alias: string, chatId: string, now: number): boolean {
    const from = normalizeChatId(alias)
    const into = this.resolveChatId(session, chatId)
    if (from === into) return false
    return this.db.transaction(() => {
      const existing = this.db
        .query('SELECT chat_id FROM contact_aliases WHERE session = ? AND alias = ?')
        .get(session, from) as { chat_id: string } | null
      if (existing?.chat_id === into) return false

      this.db
        .query(
          `INSERT INTO contact_aliases (session, alias, chat_id, linked_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (session, alias)
           DO UPDATE SET chat_id = excluded.chat_id, linked_at = excluded.linked_at`,
        )
        .run(session, from, into, now)
      // Anything that pointed at the alias now points past it: aliases never chain, so
      // resolution stays a single lookup and cannot loop.
      this.db
        .query('UPDATE contact_aliases SET chat_id = ? WHERE session = ? AND chat_id = ?')
        .run(into, session, from)

      this.mergeContact(session, from, into)
      for (const table of ['sends', 'inbound', 'queued']) {
        this.db
          .query(`UPDATE ${table} SET chat_id = ? WHERE session = ? AND chat_id = ?`)
          .run(into, session, from)
      }
      return true
    })()
  }

  /** Every spelling the guard knows for this contact, the canonical one first. */
  aliasesOf(session: string, chatId: string): string[] {
    const canonical = this.resolveChatId(session, chatId)
    const rows = this.db
      .query('SELECT alias FROM contact_aliases WHERE session = ? AND chat_id = ? ORDER BY alias')
      .all(session, canonical) as { alias: string }[]
    return [canonical, ...rows.map((r) => r.alias)]
  }

  /**
   * Combine two contact rows into one. Counters add, timestamps take the outer bound, and
   * state takes the stronger of the two — a relationship learned under either name is still
   * a relationship, and an opt-out recorded under either name still silences both.
   */
  private mergeContact(session: string, from: string, into: string): void {
    const src = this.db
      .query('SELECT * FROM contacts WHERE session = ? AND chat_id = ?')
      .get(session, from) as ContactRow | null
    if (!src) return
    this.db.query('DELETE FROM contacts WHERE session = ? AND chat_id = ?').run(session, from)

    const dst = this.insertContact(session, into, src.first_seen)
    const state = STATE_RANK[src.state] > STATE_RANK[dst.state] ? src.state : dst.state
    this.db
      .query(
        `UPDATE contacts
         SET state = ?, first_seen = ?, last_out_at = ?, last_in_at = ?, human_touch_at = ?,
             out_count = ?, in_count = ?, opted_out_at = ?
         WHERE session = ? AND chat_id = ?`,
      )
      .run(
        state,
        Math.min(src.first_seen, dst.first_seen),
        latest(src.last_out_at, dst.last_out_at),
        latest(src.last_in_at, dst.last_in_at),
        earliest(src.human_touch_at, dst.human_touch_at),
        src.out_count + dst.out_count,
        src.in_count + dst.in_count,
        state === 'opted_out' ? earliest(src.opted_out_at, dst.opted_out_at) : null,
        session,
        into,
      )
  }

  // ---- contacts -----------------------------------------------------------

  getContact(session: string, chatId: string): ContactRow | null {
    return this.db
      .query('SELECT * FROM contacts WHERE session = ? AND chat_id = ?')
      .get(session, this.resolveChatId(session, chatId)) as ContactRow | null
  }

  /** Insert-if-absent, then return the row. Never overwrites an existing state. */
  ensureContact(session: string, chatId: string, now: number): ContactRow {
    return this.insertContact(session, this.resolveChatId(session, chatId), now)
  }

  /** `ensureContact` on an id that is already resolved — the merge path must not re-resolve. */
  private insertContact(session: string, chatId: string, now: number): ContactRow {
    this.db
      .query(
        `INSERT INTO contacts (session, chat_id, state, first_seen)
         VALUES (?, ?, 'stranger', ?)
         ON CONFLICT (session, chat_id) DO NOTHING`,
      )
      .run(session, chatId, now)
    return this.db
      .query('SELECT * FROM contacts WHERE session = ? AND chat_id = ?')
      .get(session, chatId) as ContactRow
  }

  /**
   * State transitions are monotonic toward `known` — a contact that replied does not
   * regress to `stranger` because we sent again. `opted_out` is terminal until cleared.
   */
  promoteContact(session: string, chatId: string, to: ContactState, now: number): void {
    const id = this.resolveChatId(session, chatId)
    const current = this.insertContact(session, id, now)
    if (current.state === 'opted_out' && to !== 'opted_out') return
    if (STATE_RANK[to] <= STATE_RANK[current.state]) return
    this.db
      .query('UPDATE contacts SET state = ? WHERE session = ? AND chat_id = ?')
      .run(to, session, id)
  }

  /**
   * Record that a human has already spoken to this contact, without inventing a message.
   *
   * The guard only learns a relationship from a webhook it has seen, so on the day it is
   * introduced its graph is empty and `requireHumanTouch` refuses every contact the account
   * has been talking to for months. This is the write path for that: adopt the history the
   * guard was not around to observe, and for deliberately unlocking one contact later.
   *
   * Deliberately *not* `recordHumanOutbound`: that inserts a `sends` row and bumps
   * `out_count`. Backfilling a year of contacts through it would land them all in the
   * current rate window and pace the account as though it had just sent them all at once.
   * A touch is a statement about the past; it must not consume today's quota.
   *
   * Returns false when the contact was already touched, so a re-run is a no-op rather than
   * a lie about when the relationship started.
   */
  markHumanTouch(session: string, chatId: string, now: number, touchedAt?: number): boolean {
    return this.db.transaction(() => {
      const id = this.resolveChatId(session, chatId)
      const existing = this.insertContact(session, id, now)
      if (existing.human_touch_at !== null) return false
      this.db
        .query('UPDATE contacts SET human_touch_at = ? WHERE session = ? AND chat_id = ?')
        .run(touchedAt ?? now, session, id)
      this.promoteContact(session, id, 'known', now)
      return true
    })()
  }

  markOptOut(session: string, chatId: string, now: number): void {
    const id = this.resolveChatId(session, chatId)
    this.insertContact(session, id, now)
    this.db
      .query(
        "UPDATE contacts SET state = 'opted_out', opted_out_at = ? WHERE session = ? AND chat_id = ?",
      )
      .run(now, session, id)
  }

  clearOptOut(session: string, chatId: string): void {
    this.db
      .query(
        `UPDATE contacts SET state = CASE WHEN in_count > 0 THEN 'known' ELSE 'stranger' END,
                             opted_out_at = NULL
         WHERE session = ? AND chat_id = ? AND state = 'opted_out'`,
      )
      .run(session, this.resolveChatId(session, chatId))
  }

  /** Returns false if this message id was already recorded — webhooks get redelivered. */
  recordInbound(session: string, chatId: string, msgId: string | null, now: number): boolean {
    return this.db.transaction(() => {
      const id = this.resolveChatId(session, chatId)
      const res = this.db
        .query('INSERT OR IGNORE INTO inbound (session, chat_id, msg_id, at) VALUES (?, ?, ?, ?)')
        .run(session, id, msgId, now)
      if (res.changes === 0) return false
      this.insertContact(session, id, now)
      this.db
        .query(
          `UPDATE contacts
           SET in_count = in_count + 1,
               last_in_at = ?,
               human_touch_at = COALESCE(human_touch_at, ?)
           WHERE session = ? AND chat_id = ?`,
        )
        .run(now, now, session, id)
      this.promoteContact(session, id, 'known', now)
      return true
    })()
  }

  /**
   * An outbound message the guard did not send: someone typed it on the phone.
   * Recorded in `sends` too — it consumes the same real-world quota as a guard send, so
   * the sliding windows must see it.
   */
  recordHumanOutbound(session: string, chatId: string, msgId: string | null, now: number): boolean {
    return this.db.transaction(() => {
      if (msgId && this.hasSend(msgId)) return false
      const id = this.resolveChatId(session, chatId)
      this.insertContact(session, id, now)
      this.db
        .query(
          `UPDATE contacts
           SET human_touch_at = COALESCE(human_touch_at, ?), last_out_at = ?, out_count = out_count + 1
           WHERE session = ? AND chat_id = ?`,
        )
        .run(now, now, session, id)
      this.promoteContact(session, id, 'known', now)
      this.db
        .query(
          `INSERT INTO sends (session, chat_id, msg_id, sent_at, route, origin)
           VALUES (?, ?, ?, ?, 'human', 'human')`,
        )
        .run(session, id, msgId, now)
      return true
    })()
  }

  recordGuardOutbound(
    session: string,
    chatId: string,
    route: string,
    msgId: string | null,
    now: number,
  ): number {
    return this.db.transaction(() => {
      const id = this.resolveChatId(session, chatId)
      this.insertContact(session, id, now)
      this.db
        .query(
          `UPDATE contacts SET out_count = out_count + 1, last_out_at = ? WHERE session = ? AND chat_id = ?`,
        )
        .run(now, session, id)
      this.promoteContact(session, id, 'handshake_sent', now)
      const res = this.db
        .query(
          `INSERT INTO sends (session, chat_id, msg_id, sent_at, route, origin)
           VALUES (?, ?, ?, ?, ?, 'guard')`,
        )
        .run(session, id, msgId, now, route)
      return Number(res.lastInsertRowid)
    })()
  }

  /**
   * Undo a reserved send that never reached WhatsApp. Quota that was not spent must not
   * stay spent, or a flapping upstream silently ratchets the guard down to zero.
   */
  voidSend(sendId: number): void {
    this.db.transaction(() => {
      const row = this.db.query('SELECT session, chat_id FROM sends WHERE id = ?').get(sendId) as {
        session: string
        chat_id: string
      } | null
      if (!row) return
      this.db.query('DELETE FROM sends WHERE id = ?').run(sendId)
      this.db
        .query(
          `UPDATE contacts SET out_count = MAX(0, out_count - 1) WHERE session = ? AND chat_id = ?`,
        )
        .run(row.session, row.chat_id)
    })()
  }

  attachMessageId(sendId: number, msgId: string): void {
    this.db.query('UPDATE sends SET msg_id = ? WHERE id = ?').run(msgId, sendId)
  }

  hasSend(msgId: string): boolean {
    return this.db.query('SELECT 1 AS hit FROM sends WHERE msg_id = ? LIMIT 1').get(msgId) !== null
  }

  isGuardSend(msgId: string): boolean {
    return (
      this.db
        .query("SELECT 1 AS hit FROM sends WHERE msg_id = ? AND origin = 'guard' LIMIT 1")
        .get(msgId) !== null
    )
  }

  /**
   * A guard send to this chat that has not had its upstream message id attached yet.
   * Used to resolve the race where WAHA delivers `message.any` before the send response
   * has come back to us — without it, our own message looks like a human touch.
   */
  hasUnidentifiedSend(session: string, chatId: string, since: number): boolean {
    return (
      this.db
        .query(
          `SELECT 1 AS hit FROM sends
           WHERE session = ? AND chat_id = ? AND msg_id IS NULL AND origin = 'guard' AND sent_at > ?
           LIMIT 1`,
        )
        .get(session, this.resolveChatId(session, chatId), since) !== null
    )
  }

  recordAck(msgId: string, ack: number, now: number): boolean {
    const res = this.db
      .query('UPDATE sends SET ack = ?, ack_at = ? WHERE msg_id = ? AND (ack IS NULL OR ack < ?)')
      .run(ack, now, msgId, ack)
    return res.changes > 0
  }

  // ---- windows ------------------------------------------------------------

  /** The group/channel predicate `coldOpens` uses, so both counters draw the same line. */
  private static notAGroup(column: string): string {
    return `AND ${column} NOT LIKE '%@g.us' AND ${column} NOT LIKE '%@newsletter'`
  }

  /**
   * `excludeGroups` is for the counters that ration *conversations with people*. The rate
   * windows leave it false: they cap what the number puts on the wire, and a job post to a
   * community group is on the wire like anything else.
   */
  countSendsSince(session: string, since: number, excludeGroups = false): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM sends WHERE session = ? AND sent_at > ?
         ${excludeGroups ? Store.notAGroup('chat_id') : ''}`,
      )
      .get(session, since) as { n: number }
    return row.n
  }

  /**
   * The moment the oldest send inside the window ages out, freeing one slot.
   * Returns null when the window is not full.
   *
   * With `limit` sends allowed, the (limit)-th newest send in the window is the one whose
   * expiry frees capacity — so order descending and skip limit-1.
   */
  slotFreesAt(
    session: string,
    since: number,
    limit: number,
    windowMs: number,
    excludeGroups = false,
  ): number | null {
    if (!Number.isFinite(limit)) return null
    const row = this.db
      .query(
        `SELECT sent_at FROM sends
         WHERE session = ? AND sent_at > ?
         ${excludeGroups ? Store.notAGroup('chat_id') : ''}
         ORDER BY sent_at DESC
         LIMIT 1 OFFSET ?`,
      )
      .get(session, since, Math.max(0, limit - 1)) as { sent_at: number } | null
    return row ? row.sent_at + windowMs : null
  }

  lastSendAt(session: string): number | null {
    const row = this.db
      .query('SELECT MAX(sent_at) AS t FROM sends WHERE session = ?')
      .get(session) as {
      t: number | null
    }
    return row.t
  }

  /**
   * Chats whose first ever outbound was *us* opening the conversation — the cold sends.
   *
   * A chat this session had already heard from before it first wrote is a reply, not cold
   * outreach, and must not spend the cold-outreach budget. Charging it was the defect: a
   * morning of inbound candidates exhausted the day's budget and the guard then silenced
   * the replies, while genuine cold sends stayed allowed.
   *
   * The test is inbound-before-first-send, not "does the contact have a human touch". Under
   * `requireHumanTouch` every send the guard permits is to a touched contact — a batch of
   * cold numbers unlocked through `markHumanTouch` included — so keying on the touch bit
   * would exempt exactly the traffic this budget exists to cap. A stranger who replies
   * *after* we wrote also gets a touch, and that conversation was still ours to start.
   *
   * `inbound.chat_id` is resolved and folded by `linkIdentity`, so a reply that arrived
   * under a `@lid` exempts the `@c.us` chat once the two are known to be one person.
   *
   * `excludeGroups` follows `groups.mode: exempt`: a group chat has no individual on the
   * other end to be a stranger, and the gates already skip it. The counter has to skip it
   * too — a day of job posts to community groups is not twenty strangers cold-messaged, and
   * counting them spent the whole budget on chats the budget would never have refused.
   */
  private static coldOpens(excludeGroups: boolean): string {
    return `
    SELECT f.chat_id, f.first_send FROM (
      SELECT chat_id, MIN(sent_at) AS first_send FROM sends WHERE session = ?1 GROUP BY chat_id
    ) AS f
    WHERE f.first_send > ?2
      ${excludeGroups ? Store.notAGroup('f.chat_id') : ''}
      AND NOT EXISTS (
        SELECT 1 FROM inbound i
        WHERE i.session = ?1 AND i.chat_id = f.chat_id AND i.at <= f.first_send
      )`
  }

  countNewStrangersSince(session: string, cutoff: number, excludeGroups = true): number {
    const row = this.db
      .query(`SELECT COUNT(*) AS n FROM (${Store.coldOpens(excludeGroups)})`)
      .get(session, cutoff) as { n: number }
    return row.n
  }

  /** When the new-contact budget frees a slot, mirroring slotFreesAt for first sends. */
  newStrangerSlotFreesAt(
    session: string,
    cutoff: number,
    limit: number,
    windowMs: number,
    excludeGroups = true,
  ): number | null {
    if (!Number.isFinite(limit)) return null
    const row = this.db
      .query(
        `SELECT first_send FROM (${Store.coldOpens(excludeGroups)})
         ORDER BY first_send DESC
         LIMIT 1 OFFSET ?3`,
      )
      .get(session, cutoff, Math.max(0, limit - 1)) as { first_send: number } | null
    return row ? row.first_send + windowMs : null
  }

  countInboundSince(session: string, since: number): number {
    const row = this.db
      .query('SELECT COUNT(*) AS n FROM inbound WHERE session = ? AND at > ?')
      .get(session, since) as { n: number }
    return row.n
  }

  /** Undelivered ratio over the last `sample` sends old enough to have been acked. */
  undeliveredRatio(
    session: string,
    sample: number,
    olderThan: number,
  ): { ratio: number; n: number } {
    const rows = this.db
      .query(
        `SELECT ack FROM sends
         WHERE session = ? AND sent_at < ? AND origin = 'guard'
         ORDER BY sent_at DESC LIMIT ?`,
      )
      .all(session, olderThan, sample) as { ack: number | null }[]
    if (rows.length === 0) return { ratio: 0, n: 0 }
    // WAHA ack levels: -1 error, 0 pending, 1 server, 2 device, 3 read, 4 played.
    const undelivered = rows.filter((r) => r.ack === null || r.ack <= 0).length
    return { ratio: undelivered / rows.length, n: rows.length }
  }

  // ---- session state ------------------------------------------------------

  ensureSession(session: string, now: number): SessionStateRow {
    this.db
      .query(
        `INSERT INTO session_state (session, warmup_started_at) VALUES (?, ?)
         ON CONFLICT (session) DO NOTHING`,
      )
      .run(session, now)
    return this.getSession(session)!
  }

  getSession(session: string): SessionStateRow | null {
    return this.db
      .query('SELECT * FROM session_state WHERE session = ?')
      .get(session) as SessionStateRow | null
  }

  setTimelock(session: string, until: number, multiplier: number, now: number): void {
    this.ensureSession(session, now)
    this.db
      .query(
        `UPDATE session_state
         SET timelock_until = MAX(COALESCE(timelock_until, 0), ?),
             rate_multiplier = MAX(rate_multiplier, ?),
             multiplier_set_at = ?
         WHERE session = ?`,
      )
      .run(until, multiplier, now, session)
  }

  setStopped(session: string, reason: string | null, now: number): void {
    this.ensureSession(session, now)
    this.db
      .query('UPDATE session_state SET stopped_reason = ? WHERE session = ?')
      .run(reason, session)
  }

  setWarmupStart(session: string, at: number): void {
    this.ensureSession(session, at)
    this.db
      .query('UPDATE session_state SET warmup_started_at = ? WHERE session = ?')
      .run(at, session)
  }

  // ---- queue --------------------------------------------------------------

  enqueue(row: QueuedRow): void {
    this.db
      .query(
        `INSERT INTO queued
           (guard_id, session, chat_id, route, method, path, headers, body, text_length, enqueued_at, not_before)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.guard_id,
        row.session,
        this.resolveChatId(row.session, row.chat_id),
        row.route,
        row.method,
        row.path,
        row.headers,
        row.body,
        row.text_length,
        row.enqueued_at,
        row.not_before,
      )
  }

  nextQueued(session: string, now: number): QueuedRow | null {
    return this.db
      .query(
        `SELECT * FROM queued
         WHERE state = 'pending' AND session = ? AND not_before <= ?
         ORDER BY enqueued_at LIMIT 1`,
      )
      .get(session, now) as QueuedRow | null
  }

  queuedSessions(): string[] {
    return (
      this.db.query("SELECT DISTINCT session FROM queued WHERE state = 'pending'").all() as {
        session: string
      }[]
    ).map((r) => r.session)
  }

  queuedDepth(session?: string): number {
    const row = session
      ? (this.db
          .query("SELECT COUNT(*) AS n FROM queued WHERE state = 'pending' AND session = ?")
          .get(session) as { n: number })
      : (this.db.query("SELECT COUNT(*) AS n FROM queued WHERE state = 'pending'").get() as {
          n: number
        })
    return row.n
  }

  settleQueued(guardId: string, state: 'sent' | 'dropped', error: string | null): void {
    this.db
      .query('UPDATE queued SET state = ?, last_error = ? WHERE guard_id = ?')
      .run(state, error, guardId)
  }

  /** `countAttempt` is false for policy deferrals — only real failures spend attempts. */
  retryQueued(guardId: string, notBefore: number, error: string | null, countAttempt = true): void {
    this.db
      .query(
        'UPDATE queued SET attempts = attempts + ?, not_before = ?, last_error = ? WHERE guard_id = ?',
      )
      .run(countAttempt ? 1 : 0, notBefore, error, guardId)
  }

  getQueued(guardId: string): QueuedRow | null {
    return this.db.query('SELECT * FROM queued WHERE guard_id = ?').get(guardId) as QueuedRow | null
  }

  listSessions(): SessionStateRow[] {
    return this.db.query('SELECT * FROM session_state ORDER BY session').all() as SessionStateRow[]
  }
}
