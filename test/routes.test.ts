import { describe, expect, test } from 'bun:test'
import { classifyPath, isUnknownSend, KNOWN_SEND_ROUTES } from '../src/proxy/routes.ts'

const opts = { waived: new Set<string>() }
const classify = (path: string, method = 'POST') => classifyPath(path, method, opts)

describe('route classification', () => {
  test('every documented send route is intercepted', () => {
    for (const route of KNOWN_SEND_ROUTES) {
      expect(classify(`/api/${route}`).kind).toBe('send')
    }
  })

  test('the text-bearing routes expose which field carries the text', () => {
    expect(classify('/api/sendText').textField).toBe('text')
    expect(classify('/api/sendImage').textField).toBe('caption')
    expect(classify('/api/sendLocation').textField).toBeNull()
  })

  test('sendImage cannot be used to route around a throttled sendText', () => {
    // The whole point of the table: no send route is left unguarded.
    for (const route of ['sendImage', 'sendFile', 'sendVoice', 'sendVideo', 'sendPoll']) {
      expect(classify(`/api/${route}`).kind).toBe('send')
    }
  })

  test('forwarding and reactions count as message-creating', () => {
    expect(classify('/api/forwardMessage').kind).toBe('send')
    expect(classify('/api/reaction').kind).toBe('send')
  })

  test('session-scoped variants are intercepted and yield the session', () => {
    const match = classify('/api/sales/sendText')
    expect(match.kind).toBe('send')
    expect(match.sessionFromPath).toBe('sales')
    const scoped = classify('/api/sales/chats/messages')
    expect(scoped.kind).toBe('send')
    expect(scoped.sessionFromPath).toBe('sales')
  })

  test('presence routes are their own kind', () => {
    expect(classify('/api/startTyping').kind).toBe('presence')
    expect(classify('/api/stopTyping').kind).toBe('presence')
    expect(classify('/api/sendSeen').kind).toBe('presence')
    expect(classify('/api/sales/startTyping').sessionFromPath).toBe('sales')
  })

  test('everything else is a dumb pipe', () => {
    for (const path of [
      '/api/sessions',
      '/api/contacts',
      '/health',
      '/dashboard',
      '/api/version',
    ]) {
      expect(classify(path, 'GET').kind).toBe('passthrough')
    }
  })

  test('an unrecognised send-shaped route is flagged rather than waved through', () => {
    const match = classify('/api/sendSticker')
    expect(match.kind).toBe('send')
    expect(isUnknownSend(match)).toBe(true)
  })

  test('a waived path stops being flagged', () => {
    const waived = classifyPath('/api/sendSticker', 'POST', {
      waived: new Set(['/api/sendSticker']),
    })
    expect(waived.kind).toBe('passthrough')
  })

  test('GET on a send path is not a send', () => {
    expect(classify('/api/sendText', 'GET').kind).toBe('passthrough')
    expect(classify('/api/sendSticker', 'GET').kind).toBe('passthrough')
  })

  test('a trailing slash does not create a bypass', () => {
    expect(classify('/api/sendText/').kind).toBe('send')
  })

  test('non-api paths are never intercepted', () => {
    expect(classify('/sendText').kind).toBe('passthrough')
  })
})
