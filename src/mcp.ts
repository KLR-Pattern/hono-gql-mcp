/**
 * MCP face — orchestration and the HTTP mount.
 *
 * Simple mode: get_schema + graphql_query (+ graphql_mutation) — one-shot
 * discovery for small apps (mcp-tools.ts).
 * Progressive mode (mode='progressive', or mode='auto' above
 * progressiveThreshold routes): the 4-layer tag-tree walkthrough
 * (mcp-progressive.ts).
 *
 * The SDK's per-request factory (`createMcpHandler`) hands us the original
 * HTTP request, so the caller's own credentials ride into every resolver —
 * the same single-source-of-truth rule as the Python bridge.
 */
import {
  createMcpHandler,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  hostHeaderValidationResponse,
  originValidationResponse,
  McpServer,
  oauthMetadataResponse,
  requireScopes,
  type McpHttpHandler,
} from '@modelcontextprotocol/server'
import type { Hono } from 'hono'
import type { RouterGraphQLHandler } from './handler.ts'
import type { ResolvedAuth } from './auth.ts'
import { withToolSpan, type EnvelopeTrace } from './otel.ts'
import { registerExecutorTools, registerSchemaTool, sampleDocument, type ToolContext } from './mcp-tools.ts'
import { registerProgressiveTools } from './mcp-progressive.ts'

export type ToolMode = 'auto' | 'simple' | 'progressive'
/** After mode resolution: which toolset is actually registered. */
export type ResolvedMode = 'simple' | 'progressive'

export const PROGRESSIVE_THRESHOLD = 25

export interface McpFaceOptions {
  name: string
  version: string
  instructions?: string
  allowMutation: boolean
  /** Effective toolset — resolved by HonoGqlMcp from mode + route count. */
  mode: ResolvedMode
  /** Truncation bound on tool result text (default 1_000_000). */
  maxResponseChars: number
  /** Per-tool scope requirements (auth.toolScopes) — attached as SDK scope challenges, enforced pre-dispatch with HTTP 403. */
  toolScopes?: Record<string, string[]>
}

const limitText = (text: string, max: number): string =>
  text.length > max
    ? `${text.slice(0, max)}\n…[truncated — tool result exceeded maxResponseChars (${text.length} > ${max})]`
    : text

export function buildMcpHandler(handler: RouterGraphQLHandler, opts: McpFaceOptions): McpHttpHandler {
  // Handler-level state (the SDK factory below runs PER REQUEST — stateless
  // serving — so anything computed once must live outside it):
  // - sdlCache: each domain's SDL fragment, rebuilt on every get_query_schema otherwise
  // - example: the sample documents, derived from the live schema and validated once
  const sdlCache = new Map<string, string>()
  const example = {
    query: sampleDocument(handler.schema, 'query'),
    mutation: sampleDocument(handler.schema, 'mutation'),
  }
  return createMcpHandler((ctx) => {
    // Per-request: the caller's headers, captured here and passed down as
    // the GraphQL context — resolvers forward them through the whitelist.
    const callerHeaders = ctx.requestInfo?.headers
    const server = new McpServer({ name: opts.name, version: opts.version }, { instructions: opts.instructions })

    // Uniform tool registration: every tool runs inside a `tools/call <name>`
    // span, parented to the CALLER's trace when the envelope carried one
    // (2026-07-28 _meta traceparent). The SDK's callback contract is static —
    // an inputSchema-bearing tool is called handler(args, ctx), a no-input
    // tool handler(ctx) — so it is decided by the config's shape here, never
    // by sniffing the ctx object (an SDK upgrade could change ctx internals).
    // `any` here keeps the call-site callbacks' destructuring typed.
    const register = (name: string, config: unknown, cb: (args: any, ctx: any) => unknown): void => {
      const hasInput = (config as { inputSchema?: unknown }).inputSchema !== undefined
      server.registerTool(
        name,
        config as never,
        ((a: unknown, b: unknown) => {
          const [args, ctx] = hasInput ? [a, b] : [undefined, a]
          return withToolSpan(name, (ctx as { mcpReq?: { envelope?: EnvelopeTrace } })?.mcpReq?.envelope, async () =>
            (await (cb as (args: unknown, ctx: unknown) => unknown)(args, ctx)) as never,
          )
        }) as never,
      )
    }
    const text = (payload: unknown) => limitText(JSON.stringify(payload, null, 2), opts.maxResponseChars)

    // Per-tool scope challenges: the SDK enforces them before dispatch (HTTP
    // 403 + WWW-Authenticate insufficient_scope), against the authInfo the
    // endpoint gate verified for this request.
    const scopeFor = (name: string) => {
      const scopes = opts.toolScopes?.[name]
      return scopes && scopes.length > 0 ? { scopeChallenge: requireScopes(...(scopes as [string, ...string[]])) } : {}
    }

    const toolCtx: ToolContext = { handler, register, text, scopeFor }

    if (opts.mode === 'simple') {
      registerSchemaTool(toolCtx)
    } else {
      registerProgressiveTools(toolCtx, { allowMutation: opts.allowMutation, sdlCache })
    }
    registerExecutorTools(toolCtx, {
      example,
      allowMutation: opts.allowMutation,
      runDocument: (query, variables) => handler.execute(query, variables, { headers: callerHeaders }),
    })

    return server
  })
}

// ---- rate limiting (per-process, like the Python bridge's in-memory middleware) ----

export interface RateLimitOptions {
  maxPerSecond: number
  /** Caller key; default: hash of the authorization header ('anonymous' when absent). */
  keyBy?: (request: Request) => string
}

/**
 * Host/Origin validation for the MCP endpoint — DNS-rebinding and cross-site
 * protection, on the SDK's validators.
 *
 * Defaults are the localhost allowlists (safe for local development). A
 * server on a real hostname MUST pass it here — the default rejects every
 * request whose Host/Origin names another domain, CLI clients included (they
 * send Host, browsers send both). `[]` disables that half of the check.
 */
export interface HostValidationOptions {
  /** Allowed Host header hostnames, port-agnostic ('api.example.com'; IPv6 needs brackets: '[::1]'). */
  allowedHostnames?: string[]
  /** Allowed Origin header origins. A missing Origin passes (non-browser clients). */
  allowedOrigins?: string[]
}

function hashKey(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return String(h)
}

class FixedWindowLimiter {
  #counts = new Map<string, { window: number; count: number }>()
  readonly max: number

  constructor(max: number) {
    // Explicit field (no parameter property) — Node strip-only TS mode.
    this.max = max
  }

  allow(key: string): boolean {
    const now = Math.floor(Date.now() / 1000)
    const entry = this.#counts.get(key)
    if (!entry || entry.window !== now) {
      this.#counts.set(key, { window: now, count: 1 })
      this.#sweep(now)
      return true
    }
    entry.count++
    return entry.count <= this.max
  }

  /** Cheap eviction so distinct-caller floods cannot grow the map unbounded. */
  #sweep(now: number): void {
    if (this.#counts.size < 10_000) return
    for (const [k, v] of this.#counts) if (v.window !== now) this.#counts.delete(k)
  }
}

/**
 * Mount the MCP endpoint on a Hono app. Enforcement order:
 * rate limit → host/origin validation → auth gate → handler.fetch.
 * The gate's verified AuthInfo rides into the handler (factory ctx and
 * per-tool scope challenges read it). With `auth.discovery`, the two
 * RFC 9728/8414 well-known routes are mounted too — host routes registered
 * earlier win, per Hono's first-match rule.
 */
export function mountMcp(
  app: Hono<any, any, any>,
  httpHandler: McpHttpHandler,
  path = '/mcp',
  rateLimit?: RateLimitOptions,
  auth?: ResolvedAuth,
  hostValidation: HostValidationOptions = {},
): void {
  const limiter = rateLimit ? new FixedWindowLimiter(rateLimit.maxPerSecond) : undefined
  const allowedHostnames = hostValidation.allowedHostnames ?? localhostAllowedHostnames()
  const allowedOrigins = hostValidation.allowedOrigins ?? localhostAllowedOrigins()
  const serve = (c: { req: { raw: Request } }) => {
    if (limiter) {
      const key = rateLimit!.keyBy?.(c.req.raw) ?? hashKey(c.req.raw.headers.get('authorization') ?? 'anonymous')
      if (!limiter.allow(key)) {
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'rate limit exceeded', retry_after_seconds: 1 }), {
            status: 429,
            headers: { 'content-type': 'application/json' },
          }),
        )
      }
    }
    const rejected =
      (allowedHostnames.length > 0 ? hostHeaderValidationResponse(c.req.raw, allowedHostnames) : undefined) ??
      (allowedOrigins.length > 0 ? originValidationResponse(c.req.raw, allowedOrigins) : undefined)
    if (rejected) return Promise.resolve(rejected)
    if (!auth) return httpHandler.fetch(c.req.raw)
    // One token, two checks: the gate verifies the ENDPOINT; the routes'
    // own security schemes verify BUSINESS CALLS via per-caller passthrough.
    return auth.gate(c.req.raw).then((verdict) =>
      verdict.ok ? httpHandler.fetch(c.req.raw, { authInfo: verdict.authInfo }) : verdict.challenge,
    )
  }
  const base = path.replace(/\/+$/, '') || '/mcp'
  app.all(base, serve as never)
  app.all(`${base}/*`, serve as never)

  if (auth?.discovery) {
    const discoveryOptions = auth.discovery
    // oauthMetadataResponse returns undefined for non-well-known paths —
    // middleware form short-circuits on a match, falls through otherwise.
    app.get(
      '/.well-known/*',
      async (c: { req: { raw: Request } }, next: () => Promise<void>) => {
        const doc = oauthMetadataResponse(c.req.raw, discoveryOptions)
        if (doc) return doc
        await next()
      },
    ) as never
  }
}
