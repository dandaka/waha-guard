# waha-guard

A reverse proxy that speaks [WAHA](https://waha.devlike.pro)'s own REST API and sits between
your app and WAHA, applying the pacing, contact-graph and presence policy that WAHA does not
ship.

```
app ──POST /api/sendText──▶ guard ──▶ WAHA ──▶ WhatsApp
app ◀───── webhook ─────── guard ◀── webhook ┘
```

Adoption is two config lines: point your app's base URL at the guard, and point WAHA's
webhook at the guard. It is engine-agnostic (`gows` / `noweb` / `webjs` — it only uses the
REST API) and language-agnostic, which is the point: it works the same from n8n, Python,
Make, or a shell script.

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

## Quick start

```bash
docker compose -f docker-compose.example.yml up
```

Or run it directly:

```bash
GUARD_UPSTREAM=http://localhost:3000 GUARD_STATE=./state/guard.sqlite bun run src/index.ts
```

Then change two things in your own setup:

1. Your app's WAHA base URL: `http://waha:3000` → `http://waha-guard:3000`
2. WAHA's webhook URL: `https://app.example.com/webhook` → `http://waha-guard:3000/_guard/webhook`

Set `GUARD_WEBHOOK_TARGET` to your real webhook URL and the guard forwards everything on,
verbatim — body, headers (including WAHA's HMAC signature) and response status.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GUARD_UPSTREAM` | *(required)* | WAHA's base URL, e.g. `http://waha:3000` |
| `GUARD_WEBHOOK_TARGET` | — | Where webhooks are forwarded. Unset means observe-only. |
| `GUARD_WEBHOOK_PATH` | `/_guard/webhook` | Path WAHA posts to |
| `GUARD_POLICY` | — | Path to `policy.yml`. Unset means the `conservative` preset. |
| `GUARD_STATE` | `/var/lib/guard/guard.sqlite` | SQLite state file |
| `GUARD_PORT` / `GUARD_HOST` | `3000` / `0.0.0.0` | Listen address |
| `GUARD_LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |

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
consciously with `routes.waived`.

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
 → pace            spacing + gaussian jitter × contact-state multiplier
 → typing plan     sampled WPM → composing/paused cycles, re-issued before expiry
 → forward         to WAHA
 → record          durable state + message id for ack correlation
```

### Backpressure

Two modes, because it changes your app's contract:

- **`block`** (default) holds the HTTP request until the message actually goes out, which
  keeps WAHA's synchronous contract. Bounded by `backpressure.maxWaitMs`; past that you get
  **`429` + `Retry-After`** and a machine-readable `X-Guard-Reason`.
- **`queue`** returns **`202`** with a guard-side id, sends later, and emits `guard.sent` or
  `guard.dropped` to your webhook. Better for batch senders — and a different contract, so
  it is opt-in.

Policy refusals fail **closed** (`403`/`429`). Infrastructure failures fail **loud**: if WAHA
is unreachable you get a `502`, never a silent drop and never an unguarded pass-through.

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
overrides. See [`policy.example.yml`](policy.example.yml) and
[`docs/policy.md`](docs/policy.md), which documents **which numbers are measured and which
are guesses**. Most of them are guesses. Treat them that way.

```yaml
preset: conservative
quietHours:
  timezone: Europe/Lisbon
sessions:
  sales:
    contacts:
      requireHumanTouch: true
```

Run `mode: observe` to evaluate every gate and log what it *would* have done without
blocking anything. That is the safe way to introduce the guard to live traffic.

## Guard endpoints

All namespaced under `/_guard/` so they cannot shadow a WAHA route.

| Endpoint | |
|---|---|
| `GET /_guard/health` | liveness |
| `GET /_guard/status` | per-session warmup day, degraded state, queue depth |
| `GET /_guard/metrics` | Prometheus |
| `GET /_guard/policy?session=` | the effective resolved policy |
| `GET /_guard/contact?session=&chatId=` | what the guard knows about a contact |
| `GET /_guard/queue/{guardId}` | status of a queued send |
| `POST /_guard/opt-out` · `/_guard/opt-in` | manual opt-out management |
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

The gap that matters most: none of the rate numbers have been validated against a real
account over a long period. They are conservative guesses. See
[`docs/policy.md`](docs/policy.md).

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

## License

MIT
