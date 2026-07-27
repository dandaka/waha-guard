# Policy reference

Every knob, what it does, and — for the numeric defaults — **where the number came from**.

## Provenance, honestly

There is no public rate limit for WhatsApp. Nobody outside Meta knows the thresholds, and
anyone who tells you they do is quoting folklore. So each default below is tagged:

- **measured** — verified against something observable (a protocol behaviour, a timing
  checked against a running WAHA). Nothing here currently carries this tag; it is kept so
  that a contributed measurement has somewhere to land.
- **modelled** — computed from a model that is itself defensible (typing speed from
  published WPM distributions for adults on a phone keyboard).
- **reported** — taken from documentation or from what other people have observed and
  written down, but not confirmed here.
- **convention** — a definition rather than an observation.
- **guess** — a conservative number chosen because it is well under any plausible threshold.
  Most of the rate numbers are this. They are not safe *because* they are these values; they
  are chosen to be boring.

If you have data, please open an issue and replace a guess with a measurement.

---

## Top level

| Key | Default | Notes |
|---|---|---|
| `preset` | `conservative` | `conservative` \| `balanced` \| `off` |
| `mode` | `enforce` | `observe` evaluates every gate and logs what it would have done, then forwards anyway. Use it to shadow-run against live traffic. |
| `presence` | `guard` | Who owns typing indicators: `guard`, `caller` or `off`. Exactly one side must, or they interleave visibly. |
| `sessions` | `{}` | Per-session overrides, deep-merged over the base. Arrays replace wholesale. |

`null` for any numeric cap means "no limit".

## `backpressure`

| Key | Default | Provenance |
|---|---|---|
| `mode` | `block` | — |
| `maxWaitMs` | `120000` | **guess.** Long enough that ordinary pacing waits succeed, short enough to stay inside a typical HTTP client timeout. |

`block` holds the request until the message goes out, then returns WAHA's own response.
Past `maxWaitMs` it returns `429` with `Retry-After` and `X-Guard-Reason`.

`queue` returns `202` immediately with a `guardId`, persists the request, and emits
`guard.sent` / `guard.dropped` to your webhook. The queue is a table, not an array: a `202`
is a promise to deliver, and a promise that evaporates on restart is a silent drop.

## `quietHours`

| Key | Default | Provenance |
|---|---|---|
| `enabled` | `true` | — |
| `timezone` | `UTC` | **Set this.** The default is UTC because guessing is worse; the intent is recipient-local, so override per session. |
| `start` / `end` | `21:00` / `09:00` | **guess**, chosen to match ordinary social norms about when it is rude to message someone. |
| `days` | `[]` | Weekdays the window starts on, `0` = Sunday. Empty = every day. |
| `quietDays` | `[]` | Whole days that are quiet end to end. |

Windows may wrap past midnight. `quietDays` takes precedence over the hour window.

This gate is about the recipient, not about your number. It is the one to keep even if you
turn everything else off.

## `rates`

Sliding windows, per session, computed from recorded sends.

| Key | conservative | balanced | Provenance |
|---|---|---|---|
| `perMinute` | 3 | 6 | **guess** |
| `perHour` | 30 | 80 | **guess** |
| `perDay` | 150 | 400 | **guess** |
| `minSpacingMs` | 20000 | 8000 | **guess** — a floor on the gap between consecutive sends |
| `jitterStddevMs` | 8000 | 4000 | **modelled** — gaussian, truncated at ±2σ, never negative. Uniform jitter is itself a signature. |
| `stateMultipliers` | `known: 1`, `handshake_sent: 2`, `stranger: 3` | `1 / 1.5 / 2` | **guess** — messages to people who have never replied are paced slower than replies |

The multiplier applied to spacing is the contact-state multiplier times any active backoff
(timelock recovery, undelivered-ack backoff, reply-ratio `slow`).

## `warmup`

A new number that immediately sends at full rate is the most obvious pattern there is.

| Key | Default | Provenance |
|---|---|---|
| `enabled` | `true` | — |
| `schedule` | day 0: 20/day, 5 new contacts; day 3: 40/10; day 7: 80/15; day 14: 150/25 | **guess** |

`fromDay` is counted from `session_state.warmup_started_at`, which is set the first time the
guard sees a session and persists across restarts. The last step applies indefinitely.

`maxNewContactsPerDay` is a **second, independent cap** on top of
`contacts.maxNewStrangersPerDay`, and the lower one wins. A preset supplies it even when
`policy.yml` never mentions `warmup`, so raising the visible knob alone can leave you refused
by a limit you cannot see in the file you are editing. The `guard.warmup_new_contacts` body
names the step that fired, and `GET /_guard/status` reports the ramp in force per session.

Like `maxNewStrangersPerDay`, it counts only conversations this number **started** — see
below.

To restart a warmup after re-linking a number, delete the session's row or set
`warmup_started_at` — there is no API for it yet.

## `contacts`

The relationship gates. These are the ones that matter.

| Key | conservative | balanced | Provenance |
|---|---|---|---|
| `requireHumanTouch` | `true` | `false` | **judgement.** Refuse to send to any contact the guard has never seen a human message — either an inbound message, or an outbound one the guard did not send. |
| `maxNewStrangersPerDay` | 5 | 20 | **guess** |
| `handshakeMaxMessages` | 1 | 2 | **judgement.** How many messages may go to someone who has never replied. One is the honest number. |

`requireHumanTouch` is the single most useful control here and the one most likely to be
turned off for the wrong reason. It encodes the pattern that actually works: a human makes
first contact, automation takes over from the reply.

`maxNewStrangersPerDay` counts only chats **this number opened** — a first outbound to
someone the guard has no earlier inbound from. Replying to a person who messaged you first
is free, however many of them there are, and however new they are. The two acts have
opposite risk profiles and the budget exists for one of them; charging both means a good day
of inbound rations the replies to it while cold outreach carries on.

Group and channel chats are outside it too under `groups.mode: exempt`, for the same reason
they are outside the gates: there is no individual on the other end to be a stranger. They
still count against the rate windows and the warmup `maxPerDay`, which are about volume.

The test is inbound-before-first-send, deliberately not "does this contact have a human
touch". `markHumanTouch` and a message typed on the phone both set the touch bit, and under
`requireHumanTouch` that is how a cold target gets unlocked at all — so keying the budget on
the touch bit would exempt exactly the sends it exists to cap. A stranger who replies *after*
you wrote also gets the bit, and that conversation was still yours to start.

## `groups`

| Key | Default | Provenance |
|---|---|---|
| `mode` | `exempt` | **judgement.** `exempt` \| `contact` \| `block` |

Every gate under `contacts` describes a relationship with a person, and a group chat does not
have one. Applied literally, `requireHumanTouch` refuses to post to an announcement group the
business owns, and `handshakeMaxMessages: 1` mutes it permanently the first time nobody
happens to reply. `exempt` skips the contact gates for `@g.us` and `@newsletter` chats.

What it does **not** skip is the rate windows, quiet hours and pacing: a group message
consumes the same quota and is just as unwelcome at 3am. Nor does it skip opt-out — a group
that was opted out by hand stays opted out, since that is a state a human set deliberately.

Groups are also excluded from *automatic* opt-out. Keyword matching runs on inbound messages,
and in a group any one participant could otherwise mute the channel for everyone by typing
"stop".

## `replyRatio`

| Key | Default | Provenance |
|---|---|---|
| `enabled` | `true` | — |
| `maxOutPerIn` | 3 (conservative) / 6 (balanced) | **guess** |
| `minSamples` | 20 | **guess** — do not act on three messages |
| `windowHours` | 24 | **guess** |
| `action` | `block-strangers` | `block-strangers` \| `block-all` \| `slow` |
| `slowMultiplier` | 2 | applies when `action: slow` |

Talking much more than you are being talked to is the shape of broadcast, and it is visible
from the outside. `block-strangers` keeps real conversations flowing while stopping new ones.

## `optOut`

| Key | Default |
|---|---|
| `enabled` | `true` |
| `keywords` | `stop`, `unsubscribe`, `remove me`, `opt out`, `optout`, `no thanks` |

Matched against the **whole** normalized inbound message (lowercased, punctuation stripped),
not as a substring — "can you stop by tomorrow?" is not an opt-out. An opted-out contact is
refused with `403`, permanently, until cleared.

A human replying by hand from the phone clears the opt-out, on the assumption that a person
who just typed a message knows something the guard does not.

## `typing`

| Key | Default | Provenance |
|---|---|---|
| `wpmMean` | 42 | **modelled** — assumes adult phone-keyboard typing in the high 30s to mid 40s WPM. Not measured here; no source is cited for it. |
| `wpmStddev` | 12 | **modelled** |
| `wpmMin` / `wpmMax` | 20 / 80 | **modelled** — truncation bounds |
| `charsPerWord` | 5 | **convention** — five characters is the standard definition of a "word" in WPM |
| `maxPlanMs` | 25000 | **guess** — caps how long a plan can hold a `block`-mode request open |
| `refreshMs` | 8000 | **guess.** The `composing` presence expires server-side; ~10s is the commonly cited figure, and this sits under it. Verify against your engine. |
| `pauseMinMs` / `pauseMaxMs` | 700 / 2500 | **guess** — "thinking" gaps between bursts |

The duration of the indicator is `chars / charsPerWord / wpm` minutes, with `wpm` drawn per
message. This is the part that replaces a common defect: a fixed delay, or a nominal "WPM"
in the hundreds, which finishes a 300-character message in under two seconds while claiming
a human typed it.

## `timelock`

| Key | Default | Provenance |
|---|---|---|
| `enabled` | `true` | — |
| `detectStatuses` | `[429, 463]` | **reported** — 463 is widely described as the timelock status, but has not been observed by this project |
| `detectBodyPatterns` | `rate-overlimit`, `timelock`, `too many requests` | **reported** — substrings commonly described in upstream error bodies. Check yours and add to the list. |
| `degradeMinutes` | 60 | **guess** |
| `degradedMultiplier` | 5 | **guess** — spacing multiplier at the moment of detection |
| `recoveryHours` | 24 | **guess** — the multiplier decays linearly back to 1 over this period |
| `strangersBlockedWhileDegraded` | `true` | **judgement** — when the platform is pushing back, replies still go out and new conversations do not |

## `ack`

Adaptive backoff from delivery signals.

| Key | Default | Provenance |
|---|---|---|
| `enabled` | `true` | — |
| `sampleSize` | 50 | **guess** |
| `maxUndeliveredRatio` | 0.3 | **guess** |
| `slowMultiplier` | 2 | **guess** |
| `graceMinutes` | 10 | **guess** — a send younger than this is too fresh to count as undelivered |

Messages that stop being delivered is the earliest signal available that something is wrong
with the number, and it arrives before any status change does.

## `routes`

| Key | Default |
|---|---|
| `unknownSends` | `block` |
| `waived` | `[]` |

A path that looks like it creates a message but is not in the guard's route table is
refused. This is deliberately noisy: a new WAHA release adding a send endpoint should break
loudly rather than quietly open an unguarded path. Add the exact path to `waived` to pass it
through, and please open an issue so it can be guarded properly.
