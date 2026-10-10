/**
 * Executor — resolvers call the route in-process through the real app.
 *
 * `app.request()` and production `fetch` converge on the same `#dispatch`,
 * so middleware, auth and validation behave exactly as over HTTP. The only
 * credentials that ever reach a route are the caller's own, filtered through
 * the passthrough whitelist (matched case-insensitively — no smuggling
 * `x-internal-token` past the bridge).
 *
 * Hardening (same semantics as the Python bridge):
 * - `requestTimeoutMs` — per-route-call deadline. The in-process call has no
 *   HTTP client timeout to lean on, so enforcement lives in a race; a
 *   timed-out field surfaces as a `TIMEOUT` error while its siblings survive.
 *   Queue waits count against the deadline.
 * - `maxConcurrency` — bound on in-flight route calls across all queries.
 *   Sibling fields resolve concurrently; this protects the wrapped app from
 *   being hammered by its own bridge.
 */
import { GraphQLError } from 'graphql'
import type { RouteConfig } from '@asteasolutions/zod-to-openapi'
import type { Hono } from 'hono'
import { jsonBodySchemaOf } from './scanner.ts'

export interface CallPlan {
  route: RouteConfig
  /** Uppercased HTTP verb ('query' from createRoute normalizes to GET). */
  method: string
  /** True for void/no-content routes: the field is a Boolean success marker. */
  booleanSuccess: boolean
}

export type IncomingHeaders = Headers | Record<string, string> | undefined

export interface ExecutorHardening {
  /** Per-route-call deadline in ms; null disables. */
  requestTimeoutMs: number | null
  /** Bound on in-flight route calls; null disables. */
  maxConcurrency: number | null
}

/** FIFO semaphore — a released permit is handed straight to the next waiter. */
class Semaphore {
  #permits: number
  #waiters: Array<() => void> = []

  constructor(limit: number) {
    this.#permits = limit
  }

  acquire(): Promise<() => void> {
    if (this.#permits > 0) {
      this.#permits--
      return Promise.resolve(this.#releaser())
    }
    return new Promise((resolve) => {
      this.#waiters.push(() => resolve(this.#releaser()))
    })
  }

  #releaser() {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.#waiters.shift()
      if (next) next() // permit transfers; the pool count stays as-is
      else this.#permits++
    }
  }
}

function passthrough(incoming: IncomingHeaders, allow: string[]): Record<string, string> {
  const wanted = allow.map((h) => h.toLowerCase())
  const out: Record<string, string> = {}
  if (!incoming) return out
  if (incoming instanceof Headers) {
    for (const [k, v] of incoming.entries()) if (wanted.includes(k.toLowerCase())) out[k] = v
  } else {
    for (const [k, v] of Object.entries(incoming)) if (wanted.includes(k.toLowerCase())) out[k] = v
  }
  return out
}

export class RouteExecutor {
  readonly #timeoutMs: number | null
  readonly #sem: Semaphore | undefined

  constructor(
    private app: Hono,
    private passthroughHeaders: string[],
    hardening: ExecutorHardening,
  ) {
    this.#timeoutMs = hardening.requestTimeoutMs
    this.#sem = hardening.maxConcurrency === null ? undefined : new Semaphore(hardening.maxConcurrency)
  }

  async call(plan: CallPlan, args: Record<string, unknown>, incoming: IncomingHeaders): Promise<unknown> {
    const { route, method, booleanSuccess } = plan
    // '/users/{id}' → '/users/<urlencoded id>' — Starlette-style convertor-free
    const path = route.path.replace(/\{([^}]+)\}/g, (_, key: string) => {
      const v = args[key]
      if (v === undefined) throw new GraphQLError(`missing path parameter '${key}'`)
      return encodeURIComponent(String(v))
    })

    const query = new URLSearchParams()
    const queryShape = (route.request?.query as { shape?: Record<string, unknown> } | undefined)?.shape
    for (const key of Object.keys(queryShape ?? {})) {
      const v = args[key]
      if (v !== undefined) query.set(key, String(v))
    }
    const url = query.size > 0 ? `${path}?${query}` : path

    const headers = passthrough(incoming, this.passthroughHeaders)
    const init: RequestInit = { method, headers }

    const bodySchema = jsonBodySchemaOf(route)
    if (bodySchema && method !== 'GET' && method !== 'HEAD') {
      init.body = JSON.stringify(args['body'] ?? {})
      headers['content-type'] = 'application/json'
    }

    const label = `${method} ${route.path}`
    const run = async (signal: AbortSignal | undefined): Promise<Response> => {
      const release = this.#sem ? await this.#sem.acquire() : undefined
      try {
        // The queue wait counted against the deadline — nothing to run.
        if (signal?.aborted) {
          throw new GraphQLError(`TIMEOUT: ${label} exceeded ${this.#timeoutMs}ms (while queued)`)
        }
        return await this.app.request(url, init)
      } finally {
        release?.()
      }
    }

    if (this.#timeoutMs === null) return this.finish(await run(undefined), booleanSuccess)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    const deadline = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        'abort',
        () => reject(new GraphQLError(`TIMEOUT: ${label} exceeded ${this.#timeoutMs}ms`)),
        { once: true },
      )
    })
    try {
      // Best-effort downstream cancellation — enforcement is the race above.
      init.signal = controller.signal
      const res = await Promise.race([run(controller.signal), deadline])
      return this.finish(res, booleanSuccess)
    } finally {
      clearTimeout(timer)
    }
  }

  private async finish(res: Response, booleanSuccess: boolean): Promise<unknown> {
    if (!res.ok) {
      const text = await res.text()
      const detail = text ? `: ${text.slice(0, 300)}` : ''
      throw new GraphQLError(`HTTP_${res.status}${detail}`)
    }
    if (booleanSuccess) return true

    const text = await res.text()
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      // Non-JSON 2xx body: hand it over raw rather than dropping the call.
      return text
    }
  }
}
