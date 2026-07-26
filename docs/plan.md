# Design: `waha-guard` — an anti-ban sidecar for WAHA

Status: implemented (proposed 2026-07-26). This is the design document the implementation
was built from; see the [README](../README.md) for what actually ships and
[policy.md](policy.md) for the tuning reference.

## Goal

A reverse proxy that speaks WAHA's own REST API and sits between the app and WAHA,
applying pacing, contact-graph, and presence policy that WAHA does not ship.

```
app ──POST /api/sendText──▶ guard ──▶ WAHA ──▶ WhatsApp
app ◀───── webhook ─────── guard ◀── webhook ┘
```

Adoption is two config lines: point the app's base URL at the guard, point WAHA's
webhook at the guard. Engine-agnostic (`gows` / `noweb` / `webjs` —
it only uses the REST API) and language-agnostic, which is the point: WAHA's user base is
heavily n8n / Python / no-code, where a Node SDK reaches nobody.

**Framing:** most of what this enforces — quiet hours, opt-out, reply-ratio backoff,
stranger caps — protects *recipients* as much as it protects the sender's number. Build
and describe it that way.

## Non-goal

This does not make cold outreach safe. In the incident that motivated this work, the ban
signal was the contact graph, not the rate: messaging people who had never asked to hear
from the number, who did not have it in their address book, and who ignored or blocked it.
A throttle in front of that produces slower unsolicited outreach and a number that still
gets removed. Do not let this project imply otherwise, in the README or internally.

## Deployment shape

```yaml
services:
  waha:
    image: devlikeapro/waha:gows-arm-2026.7.1
    # no published port — only the guard reaches it
  waha-guard:
    image: ghcr.io/<org>/waha-guard
    ports: ['3010:3000']
    environment:
      GUARD_UPSTREAM: http://waha:3000
      GUARD_WEBHOOK_TARGET: https://app.example.com/webhook
      GUARD_POLICY: /etc/guard/policy.yml
    volumes: ['guard_state:/var/lib/guard']
```

WAHA's own webhook target is set to the guard; the guard forwards verbatim downstream.

## Core design rule: transparent by default

Any path the guard does not explicitly intercept is proxied byte-for-byte, headers and
all. This is what makes it safe to adopt and resilient to WAHA API changes. Every
interception is opt-in policy layered on top of a dumb pipe.

## Intercepted endpoints

All send endpoints must be intercepted, or callers bypass the guard by using `sendImage`.
Taken from WAHA's documented chatting API, all under `/api/` — not audited against a
specific release:

`sendText` `sendImage` `sendFile` `sendVoice` `sendVideo` `sendButtons` `sendList`
`sendPoll` `sendPollVote` `sendLocation` `sendContactVcard` `sendLinkPreview`
`send/link-custom-preview` `send/buttons/reply`

**P0 exit must include a route audit**: any other message-creating route (forwarding,
reactions, session-scoped `/api/{session}/...` variants of the above) is a bypass and
must be either intercepted or consciously waived in the policy file.

All carry `session` + `chatId`; text-bearing ones carry `text` or `caption` (drives the
WPM model). `sendSeen` / `startTyping` / `stopTyping` pass through, but a caller doing
its own typing simulation will interleave with the guard's plans — the policy file needs
a `presence: guard | caller` switch so exactly one side owns it.

## Send pipeline

```
request
 → identify        session, chatId, body length
 → classify        contact state: known | handshake_sent | stranger
 → policy gates    opt-out · quiet hours · warmup budget · stranger cap
                   · reply-ratio · timelock mode · recovery multiplier
 → acquire         sliding min/hour/day windows; per-session AND per-ip-group (P5) bucket
 → pace            spacing + gaussian jitter × per-contact-state multiplier
 → typing plan     sampled WPM → composing/paused cycles (re-issue composing ~every 8 s)
 → forward         to WAHA upstream
 → record          durable state + message id for ack correlation
```

### Backpressure semantics — decide this first

Two modes, because it changes the caller's contract:

- **`block`** (default): hold the HTTP request until the message actually goes out. Keeps
  WAHA's synchronous contract. Bounded by `maxWaitMs`; past that, return
  **`429` + `Retry-After`** with a machine-readable reason. Honest, and every HTTP client
  already understands it.
- **`queue`** (opt-in): return `202 Accepted` with a guard-side id, send later, emit a
  `guard.sent` / `guard.dropped` webhook. Better for batch senders, but it is a different
  contract — must be explicit.

Policy rejections fail **closed** (`429`/`403`). Infrastructure failures fail **loud** —
upstream unreachable is a `502`, never a silent drop and never an unguarded pass-through.

## State

SQLite by default (single file, zero setup), Postgres optional. **Durability is not
optional**: an in-memory guard resets every warmup counter and contact state on restart,
which turns a 14-day warmup ramp into a permanent day-0 ramp and silently forgets who has
opted out.

```
contacts(session, chat_id, state, first_seen, last_out_at, out_count, in_count)
sends(session, chat_id, msg_id, sent_at, ack)
session_state(session, mode, warmup_started_at, timelock_until, rate_multiplier)
```

Sliding-window budgets are computed from `sends` (`COUNT WHERE sent_at > now - window`),
not stored as counters — a stored count per window key is a fixed window that resets at
the boundary, which is the off-by-one the sliding design exists to avoid.

## Webhook observation

Event names as documented by WAHA, not audited against a specific release:

| Event | Feeds |
|---|---|
| `message` | inbound → contact becomes `known`; reply-ratio `in_count++` |
| `message.any` | all outbound, including the guard's own sends — subtract those (match `msg_id` against `sends`) and the remainder is **human-sent from the phone** → mark contact `known` |
| `message.ack` | delivery tracking → adaptive rate multiplier |
| `session.status` | `FAILED` / logged-out → global stop + alert |

The `message.any` row is the one that matters most: it is exactly the
"founder makes first contact by hand, automation takes over from the reply" flow the
incident recommends, and the guard can enforce it — *refuse to send to any contact the
guard has never seen a human touch*. That is a relationship control, and it is the one
thing a pure rate-limiter does not have.

## Policy config

YAML, with presets (`conservative` / `balanced` / `off`) and per-session overrides.
Ship `conservative` as the default and make the numbers explicit rather than folklore —
document which are measured and which are guesses.

## Phases

| Phase | Scope | Exit criterion | State |
|---|---|---|---|
| **P0** | Transparent proxy, full pass-through, contract tests against a live WAHA | A WAHA test suite passes identically through the guard | done — contract tests run against a fake WAHA; not yet verified against a live one |
| **P1** | Throttle: spacing, jitter, sliding windows, quiet hours, SQLite state, `429` semantics | A week of real dev traffic with no regressions | built; the soak has not been run |
| **P2** | Webhook observation → contact graph, reply ratio, ack tracking, human-touch rule | Contact states correct after a restart | done |
| **P3** | WPM typing plans (fixes the 240–420 WPM defect) | Indicator duration matches sampled WPM ±10 % | done, asserted in tests |
| **P4** | Timelock (463) detection, degraded mode, ban-recovery ramp | Simulated 463 blocks strangers, keeps replies flowing | done, asserted in tests |
| **P5** | Multi-upstream per-IP buckets, Prometheus metrics, docs, public release | — | metrics and docs done; per-IP buckets not started |

## Risks

- **Single point of failure in the send path.** Needs health checks, and the compose file
  must make it obvious that killing the guard stops outbound.
- **Long typing plans hold connections** in `block` mode. Cap plan duration; this
  interacts with `maxWaitMs`.
- **`composing` presence expires server-side** (~10 s, to be verified against `gows`) —
  long plans must re-issue it or the indicator visibly lapses.
- **Scope creep into a full messaging platform.** The guard proxies; it does not store
  message history, render UIs, or own identity.
