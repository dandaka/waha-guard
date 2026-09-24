# waha-guard

[![ci](https://github.com/dandaka/waha-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/dandaka/waha-guard/actions/workflows/ci.yml)

A reverse proxy that speaks [WAHA](https://waha.devlike.pro)'s own REST API and sits between
your app and WAHA, applying the pacing, contact-graph and presence policy that WAHA does not
ship.

```
app ──POST /api/sendText──▶ guard ──▶ WAHA ──▶ WhatsApp
app ◀───── webhook ─────── guard ◀── webhook ┘
```

Adoption is two config lines: point your app's base URL at the guard, and point WAHA's
webhook at the guard. Nothing else in your app changes — the guard answers with WAHA's own
responses. It is engine-agnostic (`gows` / `noweb` / `webjs` — it only uses the REST API)
and language-agnostic, which is the point: it works the same from n8n, Python, Make, or a
shell script.

## What this is not

**This does not make cold outreach safe.** Bans on WhatsApp are driven far more by the shape
of your contact graph — messaging people who never asked to hear from you, who do not have
you in their address book, and who block or ignore you — than by how fast you send. A
throttle in front of unsolicited outreach produces slower unsolicited outreach and a number
that still gets removed.

The guard exists to enforce restraint you have already decided on. Most of what it does —
quiet hours, opt-out, reply-ratio backoff, stranger caps, and refusing to message anyone a
human has never spoken to — protects the *recipient* at least as much as it protects your
number. If you are looking for something that lets you safely message strangers at volume,
this is not that, and no proxy is.

## What it looks like in practice

With the default `conservative` preset, sending to someone you have never spoken to:

```bash
curl -i -X POST localhost:3010/api/sendText \
  -H 'content-type: application/json' \
  -d '{"session":"default","chatId":"351900000000@c.us","text":"hi"}'
```

```http
HTTP/1.1 403 Forbidden
x-guard-reason: guard.no_human_touch

{"error":"guard.no_human_touch","guard":true,
 "message":"no human has ever messaged this contact from this number — send the first
            message by hand, then automation may follow"}
```

Reply to them from your phone, or let them message you first. WAHA delivers the webhook,
the guard records the human touch, and the same call now succeeds — after pacing itself and
typing for as long as the message would actually take a person to type:

```bash
curl -s localhost:3010/_guard/contact?session=default&chatId=351900000000@c.us
# {"state":"known","in_count":1,"human_touch_at":1785060305577,...}

time curl -s -X POST localhost:3010/api/sendText -d '{...,"text":"thanks for reaching out"}'
# {"id":{"_serialized":"true_351900000000@c.us_3EB0..."}}
# real  0m14.4s     <- 12s of typing indicator, then the send
```

Everything the guard does not intercept — `GET /api/sessions`, `/api/contacts`, the
dashboard, endpoints that did not exist when this was written — is proxied byte-for-byte.

## Quick start

```bash
docker compose -f docker-compose.example.yml up
```

Or run it directly against an existing WAHA:

```bash
GUARD_UPSTREAM=http://localhost:3000 GUARD_STATE=./state/guard.sqlite bun run src/index.ts
```

Then change two things in your own setup:

1. Your app's WAHA base URL: `http://waha:3000` → `http://waha-guard:3000`
2. WAHA's webhook URL: `https://app.example.com/webhook` → `http://waha-guard:3000/_guard/webhook`

Set `GUARD_WEBHOOK_TARGET` to your real webhook URL and the guard forwards everything on,
verbatim — body, headers (including WAHA's HMAC signature) and response status.

In the reference compose file WAHA publishes **no port**, so the guard is the only thing
that can reach it. That is what stops an app from quietly bypassing the guard by talking to
WAHA directly.

### Multi-session

One WAHA container can hold several sessions, and one guard fronts all of them. Pacing,
warmup, opt-outs and contact state are already per-session — every table in the state file
is keyed by session name, and `policy.yml` takes per-session overrides under `sessions:`.

The one thing that needs telling apart is **inbound**. WAHA posts every session's events to
the same webhook URL, so if your app distinguishes accounts by the URL it was called on
(`?account=…`), give each session its own target:

```yaml
GUARD_WEBHOOK_TARGETS: >
  {"pedro":"https://app.example.com/webhook?account=pedro",
   "alex":"https://app.example.com/webhook?account=alex"}
```

The session is read from the event payload, not the request path. A session not listed
falls back to `GUARD_WEBHOOK_TARGET`; if there is no fallback either, the guard answers
**502 rather than 200** so WAHA retries and the gap shows up in the log — acknowledging it
would drop that one account's inbound while every other line looked healthy.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GUARD_UPSTREAM` | *(required)* | WAHA's base URL, e.g. `http://waha:3000` |
| `GUARD_WEBHOOK_TARGET` | — | Where webhooks are forwarded. Unset means observe-only. |
| `GUARD_WEBHOOK_TARGETS` | — | JSON `{"session":"url"}` — per-session targets when one WAHA holds several sessions. See [Multi-session](#multi-session). |
| `GUARD_WEBHOOK_PATH` | `/_guard/webhook` | Path WAHA posts to |
| `GUARD_POLICY` | — | Path to `policy.yml`. Unset means the `conservative` preset. |
| `GUARD_STATE` | `/var/lib/guard/guard.sqlite` | SQLite state file |
| `GUARD_PORT` / `GUARD_HOST` | `3000` / `0.0.0.0` | Listen address |
| `GUARD_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `GUARD_API_KEY` | — | When set, `/_guard/*` endpoints (except `/_guard/health`) require this value in the `x-api-key` header. Set it whenever the guard is reachable beyond localhost. |
| `GUARD_UPSTREAM_API_KEY` | — | WAHA's own API key, used only for the guard's own lookups (resolving a LID to a phone). Proxied traffic carries the caller's key. Unset is fine — see [Who is who](#who-is-who). |

## Transparent by default

Any path the guard does not explicitly intercept is proxied byte-for-byte, headers and all.
That is what makes it safe to adopt and resilient to WAHA API changes — new endpoints, new
fields and new engines keep working without a guard release. Every interception is opt-in
policy layered on a dumb pipe.

### What is intercepted

Every message-creating route, because a caller who gets a `429` on `sendText` will otherwise
discover that `sendImage` is unguarded:

`sendText` `sendImage` `sendFile` `sendVoice` `sendVideo` `sendButtons` `sendList` `sendPoll`
`sendPollVote` `sendLocation` `sendContactVcard` `sendLinkPreview` `send/link-custom-preview`
`send/buttons/reply` `forwardMessage` `reaction` `star`

Session-scoped variants (`/api/{session}/...`) are matched too. Anything else that looks like
it creates a message but is not on the list is **refused** with `403 guard.unknown_send_route`
rather than waved through — a new WAHA release must not silently open a bypass. Waive one
consciously with `routes.waived`, and please open an issue so it can be guarded properly.

`startTyping` / `stopTyping` are suppressed when the guard owns presence, so the guard's
typing plan and your app's typing simulation cannot interleave. Set `presence: caller` to
keep them yourself.

## Send pipeline

```
request
 → identify        session, chatId, body length
 → classify        contact state: known | handshake_sent | stranger | opted_out
 → policy gates    opt-out · human touch · handshake cap · reply ratio · degraded mode
                   · quiet hours · stranger cap · warmup budget · sliding windows
                   (x-guard-force skips the budget gates only — see below)
 → pace            spacing + gaussian jitter × contact-state multiplier
 → typing plan     sampled WPM → composing/paused cycles, re-issued before expiry
 → forward         to WAHA
 → record          durable state + message id for ack correlation
```

Sends are serialized per session. Pacing that is not serialized is not pacing: two
concurrent requests would each check "was the last send 20 seconds ago?", both see yes, and
both fire.

### Backpressure

Two modes, because it changes your app's contract:

- **`block`** (default) holds the HTTP request until the message actually goes out, which
  keeps WAHA's synchronous contract. Bounded by `backpressure.maxWaitMs`; past that you get
  **`429` + `Retry-After`** and a machine-readable `X-Guard-Reason`.
- **`queue`** returns **`202`** with a guard-side id, sends later, and emits `guard.sent` or
  `guard.dropped` to your webhook. Better for batch senders — and a different contract, so
  it is opt-in. The queue is a table, not an array: a `202` is a promise to deliver, and a
  promise that evaporates on restart is a silent drop.

Policy refusals fail **closed** (`403`/`429`). Infrastructure failures fail **loud**: if WAHA
is unreachable you get a `502`, never a silent drop and never an unguarded pass-through.

When one mailbox message is delivered through several WAHA requests (for example text plus a
contact card), pass the same `x-guard-mailbox-message-id` header on every part. The guard
counts those parts as one message for the per-contact handshake limit and as one re-engagement
of that contact. The header is kept with queued sends and removed before forwarding to WAHA.
Requests without the header each count separately.

### Forcing one send past a limit

Sometimes a budget is wrong about one specific message, and the person who knows that is a
human. `x-guard-force: 1` on a single send overrides the guard's **own pacing and volume
budgets** for that request:

```bash
curl -X POST localhost:3010/api/sendText \
  -H 'x-api-key: ...' \
  -H 'x-guard-force: 1' \
  -H 'x-guard-force-reason: operator approved the Monday re-ping' \
  -d '{"session":"default","chatId":"351900000000@c.us","text":"..."}'
```

What it may override: `handshake_exhausted`, `reengagement_budget`, `reply_ratio`, `new_contact_budget`,
`warmup_budget`, `warmup_new_contacts`, `rate_minute` / `_hour` / `_day`. These are numbers we
guessed and wrote down.

What it may **never** override, and why:

| Gate | Why not |
|---|---|
| `opted_out` | Consent. A flag that could override it would make every other guarantee conditional. |
| `session_stopped` | A safety stop. Forcing past it is forcing past the alarm, not the fire. |
| `no_human_touch` | The relationship control. Skipping it turns force into a cold-outreach switch. |
| `group_blocked` | A policy statement that this session does not post to groups, not a budget that ran out. |
| `degraded` | WhatsApp itself is rate-limiting you. The one gate whose input is the platform's opinion. |
| `quiet_hours` · `quiet_day` | A 03:00 message is not worth forcing, and the send goes at 08:00 by itself. |
| `spacing` | Seconds, not a day, and it resolves itself inside `maxWaitMs`. Nothing to gain. |

The design constraints are as deliberate as the allowlist:

- **Per-request, never stored.** There is no way to grant force ahead of time, no permission
  on a contact, no flag on a message. The approval being modelled is a human saying "send
  that one anyway" about one message, so it lives exactly as long as the request does.
- **No queue.** On a `queue`-mode session the header is refused with `guard.force_not_queueable`
  rather than parked. A forced send succeeds or fails on the request that carried it; there
  is no state in which a forced message is waiting for something.
- **Not separately authenticated.** Reaching this path already needs WAHA's API key, and the
  approval is a human decision rather than a credential. A second key would give the override
  the appearance of an authorisation system without it being one.
- **Loud.** Every request logs `force requested`, and every gate it actually overrode logs
  `forced past a guard limit` with the reason code, the chat, and `x-guard-force-reason`.
  `gate_forced_total{code}` counts them. An override nobody can find afterwards is a hole in
  the audit trail.

Both headers are stripped before the request reaches WAHA.

### Reason codes

Every guard-generated response carries `X-Guard-Reason` and a JSON body with the same code,
so a client can branch on the reason without parsing prose.

| Code | Status | Meaning |
|---|---|---|
| `guard.opted_out` | 403 | Recipient asked to stop. Terminal until cleared. |
| `guard.no_human_touch` | 403 | No human has ever messaged this contact from this number. |
| `guard.handshake_exhausted` | 403 | Today's unanswered-message limit for this contact is spent. Resets at midnight. |
| `guard.reengagement_budget` | 403 | This session's daily budget for re-contacting dormant people is spent. Nothing is queued. |
| `guard.unknown_send_route` | 403 | Message-creating route the guard does not know. |
| `guard.force_not_queueable` | 400 | `x-guard-force` sent to a `queue`-mode session. |
| `guard.group_blocked` | 403 | Policy refuses group sends from this session. |
| `guard.unidentified_recipient` | 400 | No `chatId` in the request, so contact policy is blind. |
| `guard.reply_ratio` | 429 | Sending far more than is coming back. |
| `guard.quiet_hours` · `guard.quiet_day` | 429 | Outside the allowed hours for this recipient. |
| `guard.rate_minute` · `_hour` · `_day` | 429 | Sliding window full. `Retry-After` is exact. |
| `guard.spacing` | 429 | Too soon after the previous message. |
| `guard.warmup_budget` · `guard.warmup_new_contacts` | 429 | Warmup ramp for this session is spent. |
| `guard.new_contact_budget` | 429 | Daily limit on conversations *this number* starts. |
| `guard.degraded` | 429 | Upstream signalled a rate limit; only replies are going out. |
| `guard.session_reconnecting` | 429 | Session dropped and is expected straight back. The send already waited out `backpressure.maxWaitMs`; nothing was sent, so retry. |
| `guard.session_stopped` | 503 | Session is `FAILED` / logged out, or has been stopped longer than `sessionHealth.transientGraceMs`. Nothing will send. |
| `guard.upstream_unreachable` | 502 | WAHA did not answer. Nothing was sent. |

## The contact graph

The guard reads WAHA's webhooks and builds relationship state from them:

| Event | What it feeds |
|---|---|
| `message` | inbound → contact becomes `known`; reply-ratio numerator |
| `message.any` | outbound echoes. Subtract the guard's own sends and the remainder is **a message typed on the phone by a human** → contact becomes `known` |
| `message.ack` | delivery tracking → adaptive backoff when messages stop landing |
| `session.status` | `FAILED` / logged out → stop sending, loudly |

That `message.any` row is the one that matters. It lets the guard enforce the rule that
actually reflects how these accounts survive: **refuse to send to any contact a human has
never messaged**. Make first contact by hand; automation takes over from the reply. It is on
by default in the `conservative` preset (`contacts.requireHumanTouch`).

**On the day you introduce the guard, that graph is empty.** It only knows relationships it
has watched happen, so every contact the account has been talking to for months reads as
untouched and `requireHumanTouch` refuses all of them until each one writes in again. Adopt
that history with `POST /_guard/contact/human-touch` before switching to `enforce`:

```bash
curl -X POST localhost:3010/_guard/contact/human-touch \
  -H 'content-type: application/json' \
  -d '{"session":"default","chatIds":["351900000000@c.us","351900000001@c.us"]}'
```

It records the relationship without inventing a message — no `sends` row, so backfilling a
year of contacts does not land them all in today's rate window. Re-running is a no-op, and
it will not resurrect someone who opted out. The same endpoint is how you deliberately
unlock a single contact later.

### Who contacted whom

Two new-contact budgets ration how many conversations a number **starts** in a day:
`contacts.maxNewStrangersPerDay` and the warmup ramp's `maxNewContactsPerDay`. They are
about cold outreach, which is what gets numbers banned — not about how busy you are.

So a chat the guard has seen an inbound message from before it ever wrote is **not** charged
to either budget. Answering someone who just messaged you is the safest traffic an account
has, and the opposite risk profile from messaging a stranger off a list; putting both on one
counter means a morning of replies can silence the afternoon's. The exemption follows the
identity fold below, so a reply that arrived as `@lid` exempts the `@c.us` chat you answer
on.

Group and channel chats do not spend it either, when `groups.mode` is `exempt`. The gates
already skip them, and a counter that charges what the gate would never refuse just spends
the budget somewhere it was not protecting — a day of job posts to community groups reading
as twenty strangers cold-messaged, and the next real person refused.

A human touch does **not** waive the budget. `POST /_guard/contact/human-touch` and a message
typed on the phone both satisfy `requireHumanTouch`, and under that gate they are how every
permitted cold send is unlocked in the first place — waiving the budget for them would leave
it capping nothing. `GET /_guard/status` reports both caps and what today has spent, since
the warmup ramp usually comes from the preset and is invisible in `policy.yml`.

Group (`@g.us`) and channel (`@newsletter`) chats are exempt from the contact gates by
default, because every one of them describes a relationship with a person and a group does
not have one — `requireHumanTouch` on a group you own is a refusal to post to your own
announcement channel. They still count against the rate windows, quiet hours and pacing,
since they consume the same real quota. See `groups.mode` for `contact` and `block`.

### Who is who

One person reaches the guard under more than one name. WhatsApp's GOWS engine reports inbound
senders as an anonymous LID (`60851197333718@lid`) while sends are addressed to the phone
(`351920266018@c.us`), and either may arrive carrying a `:device` suffix or the
`@s.whatsapp.net` domain. A contact graph that keys on the raw string sees two strangers where
there is one relationship — and a handshake counter that can never see a reply, so every
conversation goes mute after one message.

So every chat id is folded to one identity before anything is recorded against it:

1. spellings of the same phone collapse (`351920266018:12@s.whatsapp.net` → `351920266018@c.us`);
2. a LID is matched to its phone from the alt JID the inbound payload already carries
   (`_data.Info.SenderAlt`), with no round trip;
3. failing that, the guard asks WAHA's `/lids` endpoint in the background.

A LID that resolves to nothing is still recorded under its own name — the person is real and
their messages must count — and folds into the phone's row the moment either route resolves,
which credits the earlier replies retroactively. **What goes on the wire is never rewritten:**
WhatsApp is addressed with exactly the id the caller asked for. Only the bookkeeping is
canonical.

The observer learns all of this from messages it sees — which is no help to a thread that was
*already* stuck when the guard was upgraded, because merging its rows needs a new inbound
message and the stuck handshake is what stops you asking for one. Break that deadlock by hand:

```bash
curl -X POST localhost:3010/_guard/contact/link \
  -H 'content-type: application/json' \
  -d '{"session":"default","alias":"60851197333718@lid","chatId":"351920266018@c.us"}'
```

Opt-out keywords are matched against the whole normalized message, not as a substring, so
"can you stop by tomorrow?" is not an opt-out. They are not matched in groups at all, where
any one participant could otherwise mute the channel for everyone. A human replying by hand from the phone
clears an opt-out — a person who just typed a message knows something the guard does not.

## State

SQLite, one file. Durability is not optional here — an in-memory guard resets every warmup
counter and forgets every opt-out on restart, which is worse than having no guard at all
because you would still believe you had one.

Sliding-window budgets are computed from the recorded sends (`COUNT WHERE sent_at > cutoff`),
not from stored per-window counters. A stored counter is a *fixed* window that resets at the
boundary, which lets a caller send twice the cap across it.

Messages typed on the phone count against the same windows, because they consume the same
real quota.

## Policy

YAML with three presets — `conservative` (default), `balanced`, `off` — and per-session
overrides:

```yaml
preset: conservative
quietHours:
  timezone: Europe/Lisbon
sessions:
  support:
    contacts:
      requireHumanTouch: false   # inbound support is a conversation, not outreach
    quietHours:
      enabled: false
```

Run `mode: observe` to evaluate every gate and log what it *would* have done without
blocking anything. That is the safe way to introduce the guard to live traffic.

See [`policy.example.yml`](policy.example.yml) for every key with comments, and
[`docs/policy.md`](docs/policy.md) for the reference — which tags **where every default came
from**. None of them are measurements. Most are conservative guesses, and they are safe only
in the sense of being boring. Treat them that way.

## Guard endpoints

All namespaced under `/_guard/` so they cannot shadow a WAHA route.

| Endpoint | |
|---|---|
| `GET /_guard/health` | liveness |
| `GET /_guard/status` | per-session warmup day, degraded state, queue depth, and both new-contact caps with today's spend |
| `GET /_guard/metrics` | Prometheus |
| `GET /_guard/policy?session=` | the effective resolved policy |
| `GET /_guard/contact?session=&chatId=` | what the guard knows about a contact, and every id it believes is that person |
| `GET /_guard/queue/{guardId}` | status of a queued send |
| `POST /_guard/opt-out` · `/_guard/opt-in` | manual opt-out management |
| `POST /_guard/contact/human-touch` | record that a human already spoke to a contact (`chatId` or `chatIds`) |
| `POST /_guard/contact/link` | declare that `alias` and `chatId` are one person, merging what was recorded under each |
| `POST /_guard/resume` | clear a stopped session after you have checked it |

## Status

| | Scope | State |
|---|---|---|
| P0 | Transparent proxy, full pass-through, route audit | done |
| P1 | Spacing, jitter, sliding windows, quiet hours, SQLite state, `429` semantics | done |
| P2 | Webhook observation, contact graph, reply ratio, ack tracking, human-touch rule | done |
| P3 | WPM typing plans | done |
| P4 | Timelock detection, degraded mode, recovery ramp | done |
| P5 | Prometheus metrics, docs | done |
| — | Multi-upstream per-IP buckets | not started |
| — | Postgres state backend | not started |

Two honest gaps. The contract tests run against a fake WAHA, not a live one. And none of the
rate numbers have been validated against a real account over a long period — they are
conservative guesses, documented as such in [`docs/policy.md`](docs/policy.md). If you have
data, an issue replacing a guess with a measurement is the most valuable thing you could
contribute.

## Operational risks

- **The guard is a single point of failure in your send path.** If it is down, nothing goes
  out. That is deliberate — the alternative is failing open — but it means you need a health
  check on it.
- **`block` mode holds connections.** A long typing plan plus a pacing wait can hold an HTTP
  request for a while. `backpressure.maxWaitMs` bounds it; your client's timeout should be
  comfortably longer.
- **`composing` presence expires server-side.** Long typing plans re-issue it; the interval
  is `typing.refreshMs` and the default (8s) is a conservative guess, not a measurement.

## Development

```bash
bun install
bun test
bun run typecheck
bun run lint
```

Pacing is tested against an injectable clock rather than by sleeping, so the whole suite
runs in under two seconds. `test/helpers.ts` has a fake WAHA that records what it was asked
to do.

## Docs

- [`docs/policy.md`](docs/policy.md) — every policy key, and the provenance of every default
- [`docs/plan.md`](docs/plan.md) — the design document this was built from
- [`policy.example.yml`](policy.example.yml) — a fully commented policy file

## License

MIT
