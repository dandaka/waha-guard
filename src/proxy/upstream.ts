/**
 * The dumb pipe.
 *
 * Any path the guard does not explicitly intercept goes through here unchanged. This is
 * what makes the guard safe to adopt and resilient to WAHA API changes: new endpoints,
 * new fields and new engines keep working without a guard release.
 */

/** Per RFC 9110 these are connection-scoped and must not be forwarded. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

export interface UpstreamOptions {
  /** e.g. http://waha:3000 */
  base: string
  timeoutMs: number
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly cause_: unknown,
  ) {
    super(message)
  }
}

export function upstreamUrl(base: string, req: Request): string {
  const incoming = new URL(req.url)
  const target = new URL(base)
  target.pathname = incoming.pathname
  target.search = incoming.search
  return target.toString()
}

export function forwardHeaders(req: Request): Headers {
  const out = new Headers()
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    // The upstream is a different host; let fetch set it.
    if (lower === 'host') continue
    // We cannot re-compress, so we ask upstream for identity and hand the client identity.
    // guard -> WAHA is a container-local hop; there is nothing to save by compressing it.
    if (lower === 'accept-encoding') continue
    out.append(name, value)
  }
  out.set('accept-encoding', 'identity')
  return out
}

export function responseHeaders(upstream: Response): Headers {
  const out = new Headers()
  for (const [name, value] of upstream.headers) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower)) continue
    // fetch may have decoded the body; a stale content-encoding/length would corrupt it.
    if (lower === 'content-encoding' || lower === 'content-length') continue
    out.append(name, value)
  }
  return out
}

export class Upstream {
  constructor(private readonly options: UpstreamOptions) {}

  /** Byte-for-byte proxy of an arbitrary request. */
  async pass(req: Request, body?: RequestInit['body']): Promise<Response> {
    const hasBody =
      body !== undefined ? body !== null : !(req.method === 'GET' || req.method === 'HEAD')
    const upstream = await this.raw(upstreamUrl(this.options.base, req), {
      method: req.method,
      headers: forwardHeaders(req),
      body: body !== undefined ? body : hasBody ? req.body : null,
      // Required when streaming a request body.
      ...(hasBody && body === undefined ? { duplex: 'half' } : {}),
    })
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders(upstream),
    })
  }

  /** POST a JSON body to an upstream path, used by the guard's own presence calls. */
  async postJson(path: string, body: unknown, headers?: Headers): Promise<Response> {
    const out = new Headers(headers ?? {})
    out.set('content-type', 'application/json')
    out.delete('content-length')
    return this.raw(new URL(path, this.options.base).toString(), {
      method: 'POST',
      headers: out,
      body: JSON.stringify(body),
    })
  }

  private async raw(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs) })
    } catch (err) {
      // Never silently swallow this: a send that did not reach WAHA must not look like a
      // send that WAHA rejected, and must never look like a success.
      throw new UpstreamError(`upstream request failed: ${url}`, err)
    }
  }
}
