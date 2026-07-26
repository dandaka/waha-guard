import { Database } from 'bun:sqlite'
import type { ContactState } from '../policy/schema.ts'

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
]

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

  // ---- contacts -----------------------------------------------------------

  getContact(session: string, chatId: string): ContactRow | null {
    return this.db
      .query('SELECT * FROM contacts WHERE session = ? AND chat_id = ?')
      .get(session, chatId) as ContactRow | null
  }

  /** Insert-if-absent, then return the row. Never overwrites an existing state. */
  ensureContact(session: string, chatId: string, now: number): ContactRow {
    this.db
      .query(
        `INSERT INTO contacts (session, chat_id, state, first_seen)
         VALUES (?, ?, 'stranger', ?)
         ON CONFLICT (session, chat_id) DO NOTHING`,
      )
      .run(session, chatId, now)
    return this.getContact(session, chatId)!
  }

  /**
   * State transitions are monotonic toward `known` — a contact that replied does not
   * regress to `stranger` because we sent again. `opted_out` is terminal until cleared.
   */
  promoteContact(session: string, chatId: string, to: ContactState, now: number): void {
    const rank: Record<ContactState, number> = {
      stranger: 0,
      handshake_sent: 1,
      known: 2,
      opted_out: 3,
    }
    const current = this.ensureContact(session, chatId, now)
    if (current.state === 'opted_out' && to !== 'opted_out') return
    if (rank[to] <= rank[current.state]) return
    this.db
      .query('UPDATE contacts SET state = ? WHERE session = ? AND chat_id = ?')
      .run(to, session, chatId)
  }

  markOptOut(session: string, chatId: string, now: number): void {
    this.ensureContact(session, chatId, now)
    this.db
      .query(
        "UPDATE contacts SET state = 'opted_out', opted_out_at = ? WHERE session = ? AND chat_id = ?",
      )
      .run(now, session, chatId)
  }

  clearOptOut(session: string, chatId: string): void {
    this.db
      .query(
        `UPDATE contacts SET state = CASE WHEN in_count > 0 THEN 'known' ELSE 'stranger' END,
                             opted_out_at = NULL
         WHERE session = ? AND chat_id = ? AND state = 'opted_out'`,
      )
      .run(session, chatId)
  }

  /** Returns false if this message id was already recorded — webhooks get redelivered. */
  recordInbound(session: string, chatId: string, msgId: string | null, now: number): boolean {
    return this.db.transaction(() => {
      const res = this.db
        .query('INSERT OR IGNORE INTO inbound (session, chat_id, msg_id, at) VALUES (?, ?, ?, ?)')
        .run(session, chatId, msgId, now)
      if (res.changes === 0) return false
      this.ensureContact(session, chatId, now)
      this.db
        .query(
          `UPDATE contacts
           SET in_count = in_count + 1,
               last_in_at = ?,
               human_touch_at = COALESCE(human_touch_at, ?)
           WHERE session = ? AND chat_id = ?`,
        )
        .run(now, now, session, chatId)
      this.promoteContact(session, chatId, 'known', now)
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
      this.ensureContact(session, chatId, now)
      this.db
        .query(
          `UPDATE contacts
           SET human_touch_at = COALESCE(human_touch_at, ?), last_out_at = ?, out_count = out_count + 1
           WHERE session = ? AND chat_id = ?`,
        )
        .run(now, now, session, chatId)
      this.promoteContact(session, chatId, 'known', now)
      this.db
        .query(
          `INSERT INTO sends (session, chat_id, msg_id, sent_at, route, origin)
           VALUES (?, ?, ?, ?, 'human', 'human')`,
        )
        .run(session, chatId, msgId, now)
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
      this.ensureContact(session, chatId, now)
      this.db
        .query(
          `UPDATE contacts SET out_count = out_count + 1, last_out_at = ? WHERE session = ? AND chat_id = ?`,
        )
        .run(now, session, chatId)
      this.promoteContact(session, chatId, 'handshake_sent', now)
      const res = this.db
        .query(
          `INSERT INTO sends (session, chat_id, msg_id, sent_at, route, origin)
           VALUES (?, ?, ?, ?, ?, 'guard')`,
        )
        .run(session, chatId, msgId, now, route)
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
        .get(session, chatId, since) !== null
    )
  }

  recordAck(msgId: string, ack: number, now: number): boolean {
    const res = this.db
      .query('UPDATE sends SET ack = ?, ack_at = ? WHERE msg_id = ? AND (ack IS NULL OR ack < ?)')
      .run(ack, now, msgId, ack)
    return res.changes > 0
  }

  // ---- windows ------------------------------------------------------------

  countSendsSince(session: string, since: number): number {
    const row = this.db
      .query('SELECT COUNT(*) AS n FROM sends WHERE session = ? AND sent_at > ?')
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
  slotFreesAt(session: string, since: number, limit: number, windowMs: number): number | null {
    if (!Number.isFinite(limit)) return null
    const row = this.db
      .query(
        `SELECT sent_at FROM sends
         WHERE session = ? AND sent_at > ?
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

  /** Distinct chats that received their *first ever* guard send since `cutoff`. */
  countNewContactsSince(session: string, cutoff: number): number {
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n FROM (
           SELECT chat_id, MIN(sent_at) AS first_send
           FROM sends WHERE session = ?
           GROUP BY chat_id
         ) WHERE first_send > ?`,
      )
      .get(session, cutoff) as { n: number }
    return row.n
  }

  /** When the new-contact budget frees a slot, mirroring slotFreesAt for first sends. */
  newContactSlotFreesAt(
    session: string,
    cutoff: number,
    limit: number,
    windowMs: number,
  ): number | null {
    if (!Number.isFinite(limit)) return null
    const row = this.db
      .query(
        `SELECT first_send FROM (
           SELECT chat_id, MIN(sent_at) AS first_send FROM sends WHERE session = ? GROUP BY chat_id
         ) WHERE first_send > ?
         ORDER BY first_send DESC
         LIMIT 1 OFFSET ?`,
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
        row.chat_id,
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
