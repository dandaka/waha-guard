import { afterEach, describe, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { Store } from '../src/state/store.ts'
import { DAY, MINUTE } from '../src/util/time.ts'

const T0 = 1_700_000_000_000
const files: string[] = []

function tempStore(): { store: Store; path: string } {
  const path = `/tmp/waha-guard-test-${Math.random().toString(36).slice(2)}.sqlite`
  files.push(path)
  return { store: new Store(path), path }
}

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${f}${suffix}`, { force: true })
  }
})

describe('contacts', () => {
  test('a new contact starts as a stranger with no human touch', () => {
    const store = new Store(':memory:')
    const contact = store.ensureContact('s', 'a@c.us', T0)
    expect(contact.state).toBe('stranger')
    expect(contact.human_touch_at).toBeNull()
    expect(contact.out_count).toBe(0)
  })

  test('sending promotes a stranger to handshake_sent, replying promotes to known', () => {
    const store = new Store(':memory:')
    store.recordGuardOutbound('s', 'a@c.us', 'sendText', 'm1', T0)
    expect(store.getContact('s', 'a@c.us')!.state).toBe('handshake_sent')
    store.recordInbound('s', 'a@c.us', 'in1', T0 + 1000)
    expect(store.getContact('s', 'a@c.us')!.state).toBe('known')
  })

  test('state never regresses once a contact is known', () => {
    const store = new Store(':memory:')
    store.recordInbound('s', 'a@c.us', 'in1', T0)
    store.recordGuardOutbound('s', 'a@c.us', 'sendText', 'm1', T0 + 1)
    expect(store.getContact('s', 'a@c.us')!.state).toBe('known')
  })

  test('opt-out survives further sends and is only cleared explicitly', () => {
    const store = new Store(':memory:')
    store.recordInbound('s', 'a@c.us', 'in1', T0)
    store.markOptOut('s', 'a@c.us', T0 + 1)
    store.recordInbound('s', 'a@c.us', 'in2', T0 + 2)
    expect(store.getContact('s', 'a@c.us')!.state).toBe('opted_out')
    store.clearOptOut('s', 'a@c.us')
    expect(store.getContact('s', 'a@c.us')!.state).toBe('known')
  })

  test('a redelivered inbound webhook is counted once', () => {
    const store = new Store(':memory:')
    expect(store.recordInbound('s', 'a@c.us', 'in1', T0)).toBe(true)
    expect(store.recordInbound('s', 'a@c.us', 'in1', T0 + 5)).toBe(false)
    expect(store.getContact('s', 'a@c.us')!.in_count).toBe(1)
  })

  test('a message typed on the phone marks the contact as touched by a human', () => {
    const store = new Store(':memory:')
    store.recordHumanOutbound('s', 'a@c.us', 'h1', T0)
    const contact = store.getContact('s', 'a@c.us')!
    expect(contact.human_touch_at).toBe(T0)
    expect(contact.state).toBe('known')
    // ...and it consumes the same real quota as a guard send.
    expect(store.countSendsSince('s', T0 - MINUTE)).toBe(1)
  })
})

describe('sliding windows', () => {
  test('counts only what is inside the window', () => {
    const store = new Store(':memory:')
    store.recordGuardOutbound('s', 'a@c.us', 'sendText', 'm1', T0)
    store.recordGuardOutbound('s', 'b@c.us', 'sendText', 'm2', T0 + 30_000)
    expect(store.countSendsSince('s', T0 + 29_000)).toBe(1)
    expect(store.countSendsSince('s', T0 - 1)).toBe(2)
  })

  test('a window is a sliding window, not a bucket that resets at the boundary', () => {
    const store = new Store(':memory:')
    // Three sends at the end of one minute. A fixed-window counter would allow three more
    // one millisecond later; a sliding window does not.
    for (let i = 0; i < 3; i++)
      store.recordGuardOutbound('s', 'a@c.us', 'sendText', `m${i}`, T0 + 59_000 + i)
    const justAfterTheBoundary = T0 + 60_001
    expect(store.countSendsSince('s', justAfterTheBoundary - MINUTE)).toBe(3)
  })

  test('slotFreesAt is the moment the limit-th newest send ages out', () => {
    const store = new Store(':memory:')
    store.recordGuardOutbound('s', 'a@c.us', 'sendText', 'm1', T0)
    store.recordGuardOutbound('s', 'a@c.us', 'sendText', 'm2', T0 + 10_000)
    store.recordGuardOutbound('s', 'a@c.us', 'sendText', 'm3', T0 + 20_000)
    // Limit 3, window 1 min: capacity returns when the oldest of the three expires.
    expect(store.slotFreesAt('s', T0 - MINUTE, 3, MINUTE)).toBe(T0 + MINUTE)
    // Limit 2: capacity returns when the second-newest expires.
    expect(store.slotFreesAt('s', T0 - MINUTE, 2, MINUTE)).toBe(T0 + 10_000 + MINUTE)
  })

  test('an unlimited window never blocks', () => {
    const store = new Store(':memory:')
    expect(store.slotFreesAt('s', T0, Number.POSITIVE_INFINITY, MINUTE)).toBeNull()
  })

  test('new-contact budget counts first sends, not repeat sends', () => {
    const store = new Store(':memory:')
    store.recordGuardOutbound('s', 'a@c.us', 'sendText', 'm1', T0)
    store.recordGuardOutbound('s', 'a@c.us', 'sendText', 'm2', T0 + 1000)
    store.recordGuardOutbound('s', 'b@c.us', 'sendText', 'm3', T0 + 2000)
    expect(store.countNewStrangersSince('s', T0 - DAY)).toBe(2)
    expect(store.newStrangerSlotFreesAt('s', T0 - DAY, 2, DAY)).toBe(T0 + DAY)
  })

  test('answering someone who wrote first is not a new stranger', () => {
    const store = new Store(':memory:')
    store.recordInbound('s', 'inbound@c.us', 'in1', T0)
    store.recordGuardOutbound('s', 'inbound@c.us', 'sendText', 'm1', T0 + 1000)
    store.recordGuardOutbound('s', 'cold@c.us', 'sendText', 'm2', T0 + 2000)
    expect(store.countNewStrangersSince('s', T0 - DAY)).toBe(1)
    // The one cold open is also the one whose slot has to expire.
    expect(store.newStrangerSlotFreesAt('s', T0 - DAY, 1, DAY)).toBe(T0 + 2000 + DAY)
  })

  test('a stranger who replies later still spent the budget when we opened', () => {
    const store = new Store(':memory:')
    store.recordGuardOutbound('s', 'cold@c.us', 'sendText', 'm1', T0)
    store.recordInbound('s', 'cold@c.us', 'in1', T0 + 60_000)
    expect(store.countNewStrangersSince('s', T0 - DAY)).toBe(1)
  })

  test('a human typing the first message on the phone is still cold outreach', () => {
    const store = new Store(':memory:')
    store.recordHumanOutbound('s', 'cold@c.us', 'm1', T0)
    expect(store.countNewStrangersSince('s', T0 - DAY)).toBe(1)
  })

  test('group posts do not spend the budget the gates never charge them against', () => {
    const store = new Store(':memory:')
    store.recordGuardOutbound('s', '120363409740530524@g.us', 'sendText', 'm1', T0)
    store.recordGuardOutbound('s', '120363408782036358@g.us', 'sendText', 'm2', T0 + 1000)
    store.recordGuardOutbound('s', 'cold@c.us', 'sendText', 'm3', T0 + 2000)
    expect(store.countNewStrangersSince('s', T0 - DAY)).toBe(1)
    // ...unless the policy treats groups as contacts, which is what the flag is for.
    expect(store.countNewStrangersSince('s', T0 - DAY, false)).toBe(3)
  })

  test('unlocking a stranger with a human touch does not buy a free cold send', () => {
    // Under requireHumanTouch this is how every permitted cold send is opened, so exempting
    // it would leave the budget with nothing left to cap.
    const store = new Store(':memory:')
    store.markHumanTouch('s', 'cold@c.us', T0)
    store.recordGuardOutbound('s', 'cold@c.us', 'sendText', 'm1', T0 + 1000)
    expect(store.countNewStrangersSince('s', T0 - DAY)).toBe(1)
  })

  test('an inbound under a @lid exempts the phone chat once they are linked', () => {
    const store = new Store(':memory:')
    store.recordInbound('s', '60851197333718@lid', 'in1', T0)
    store.recordGuardOutbound('s', '351920266018@c.us', 'sendText', 'm1', T0 + 1000)
    // Two rows until the link lands — and the send counts, because the guard cannot yet
    // see that these are one person.
    expect(store.countNewStrangersSince('s', T0 - DAY)).toBe(1)

    store.linkIdentity('s', '60851197333718@lid', '351920266018@c.us', T0 + 2000)
    expect(store.countNewStrangersSince('s', T0 - DAY)).toBe(0)
  })

  test('windows are per session', () => {
    const store = new Store(':memory:')
    store.recordGuardOutbound('sales', 'a@c.us', 'sendText', 'm1', T0)
    expect(store.countSendsSince('support', T0 - MINUTE)).toBe(0)
  })
})

describe('acks', () => {
  test('an ack is matched to the send and never moves backwards', () => {
    const store = new Store(':memory:')
    store.recordGuardOutbound('s', 'a@c.us', 'sendText', 'm1', T0)
    expect(store.recordAck('m1', 2, T0 + 100)).toBe(true)
    expect(store.recordAck('m1', 1, T0 + 200)).toBe(false)
    expect(store.recordAck('m1', 3, T0 + 300)).toBe(true)
  })

  test('undelivered ratio ignores sends too fresh to have been acked', () => {
    const store = new Store(':memory:')
    for (let i = 0; i < 4; i++)
      store.recordGuardOutbound('s', 'a@c.us', 'sendText', `m${i}`, T0 + i)
    store.recordAck('m0', 2, T0 + 10)
    store.recordAck('m1', 3, T0 + 10)
    expect(store.undeliveredRatio('s', 50, T0 + 100).ratio).toBe(0.5)
    expect(store.undeliveredRatio('s', 50, T0 - 1).n).toBe(0)
  })
})

describe('voiding a reserved send', () => {
  test('a send that never left does not stay charged against the budget', () => {
    const store = new Store(':memory:')
    const id = store.recordGuardOutbound('s', 'a@c.us', 'sendText', null, T0)
    expect(store.countSendsSince('s', T0 - MINUTE)).toBe(1)
    store.voidSend(id)
    expect(store.countSendsSince('s', T0 - MINUTE)).toBe(0)
    expect(store.getContact('s', 'a@c.us')!.out_count).toBe(0)
  })
})

describe('durability', () => {
  test('contact graph, warmup start and opt-outs survive a restart', () => {
    const { store, path } = tempStore()
    store.ensureSession('s', T0)
    store.recordInbound('s', 'a@c.us', 'in1', T0)
    store.markOptOut('s', 'b@c.us', T0)
    store.recordGuardOutbound('s', 'c@c.us', 'sendText', 'm1', T0)
    store.close()

    const reopened = new Store(path)
    expect(reopened.getContact('s', 'a@c.us')!.state).toBe('known')
    expect(reopened.getContact('s', 'b@c.us')!.state).toBe('opted_out')
    expect(reopened.getSession('s')!.warmup_started_at).toBe(T0)
    // The window is computed from the persisted sends, so the budget is not refunded by
    // a restart — the bug that made in-memory warmup counters worthless.
    expect(reopened.countSendsSince('s', T0 - DAY)).toBe(1)
    reopened.close()
  })

  test('a queued send survives a restart', () => {
    const { store, path } = tempStore()
    store.enqueue({
      guard_id: 'g1',
      session: 's',
      chat_id: 'a@c.us',
      route: 'sendText',
      method: 'POST',
      path: '/api/sendText',
      headers: '[]',
      body: new TextEncoder().encode('{"chatId":"a@c.us"}'),
      text_length: 5,
      enqueued_at: T0,
      not_before: 0,
      attempts: 0,
      state: 'pending',
      last_error: null,
    })
    store.close()

    const reopened = new Store(path)
    expect(reopened.queuedDepth()).toBe(1)
    expect(reopened.nextQueued('s', T0)!.guard_id).toBe('g1')
    reopened.close()
  })
})
