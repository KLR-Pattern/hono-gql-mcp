/**
 * hono-gql-mcp — the agent access layer for Hono.
 *
 * Agents call one `graphql_query` tool with full composition and per-caller
 * credentials, instead of one tool per route. The GraphQL layer and the MCP
 * server are derived from your existing `@hono/zod-openapi` app: zero
 * decorators, zero schema changes.
 *
 * ```ts
 * import { OpenAPIHono } from '@hono/zod-openapi'
 * import { HonoGqlMcp } from 'hono-gql-mcp'
 *
 * const app = new OpenAPIHono()
 * // ... your existing createRoute() routes, app.openapi(route, handler) ...
 *
 * const mcp = new HonoGqlMcp(app, { name: 'my-app' })
 * mcp.mountTo(app, '/mcp')      // MCP at /mcp, auth rides the caller's headers
 * mcp.mountGraphQL(app)         // optional: POST /graphql + GraphiQL
 * ```
 */
import { Hono, type Hono as HonoType } from 'hono'
import type { McpHttpHandler } from '@modelcontextprotocol/server'
import type { OpenAPIHono } from '@hono/zod-openapi'
import { RouterGraphQLHandler } from './handler.ts'
import { buildMcpHandler, mountMcp, PROGRESSIVE_THRESHOLD, type RateLimitOptions, type ResolvedMode, type ToolMode } from './mcp.ts'
import { mountGraphQL, type GraphqlMountOptions } from './http-api.ts'
import { resolveAuth, type AuthDiscoveryOptions, type AuthOptions, type ResolvedAuth } from './auth.ts'
import { HonoGqlMcpConfigError } from './errors.ts'
import type { ScanFilters } from './scanner.ts'

export { HonoGqlMcpConfigError, DuplicateFieldError } from './errors.ts'

export interface BridgeOptions extends ScanFilters {
  /** MCP server name (shows in tool listings). Default 'hono-app'. */
  name?: string
  /** MCP server version. Default '0.1.0'. */
  version?: string
  /** Expose write routes (POST/PUT/PATCH/DELETE) as GraphQL mutations + the graphql_mutation tool. Default false. */
  allowMutation?: boolean
  /**
   * fnmatch globs over route paths limiting WHICH write routes become
   * mutations (requires allowMutation: true).
   */
  mutationInclude?: string[]
  /**
   * Header names forwarded from the MCP/GraphQL caller to the routes,
   * matched case-insensitively. Default ['authorization'] — pass [] to
   * disable forwarding entirely. Session cookies ride the `cookie` header:
   * whitelist it for cookie-authenticated apps.
   */
  passthroughHeaders?: string[]
  /** `initialize` handshake instructions — the agent's first read. Keep it under ~120 tokens. */
  instructions?: string
  /**
   * Toolset: 'simple' registers get_schema + graphql_query; 'progressive'
   * registers the 4-layer tag walkthrough (list_domains → list_queries →
   * get_query_schema → graphql_query); 'auto' (default) picks progressive
   * once the schema carries more than progressiveThreshold routes.
   */
  mode?: ToolMode
  /** Route count above which 'auto' prefers progressive disclosure. Default 25. */
  progressiveThreshold?: number
  /** Hardening knobs — same semantics and defaults as the Python bridge. */
  requestTimeoutMs?: number | null
  maxConcurrency?: number | null
  maxDepth?: number | null
  documentCacheSize?: number
  /** Truncation bound on tool result text (default 1_000_000 chars). */
  maxResponseChars?: number
  /**
   * Per-process fixed-window rate limit on the MCP endpoint. Keyed by the
   * caller's authorization header by default (hashed — credentials are never
   * stored); pass keyBy to key differently.
   */
  rateLimit?: RateLimitOptions
  /**
   * Gate the MCP endpoint: Bearer verification (401), endpoint-level and
   * per-tool scopes (403), optional RFC 9728 discovery documents.
   * See AuthOptions — one token, two checks: the gate verifies the endpoint,
   * the routes' own security schemes verify business calls.
   */
  auth?: AuthOptions
}

export class HonoGqlMcp {
  /** The plain-GraphQL face: getSDL(), execute(), readiness(), skips, registry, … */
  readonly handler: RouterGraphQLHandler
  /** Which toolset is actually registered ('auto' resolved from route count). */
  readonly resolvedMode: ResolvedMode
  readonly #name: string
  readonly #version: string
  readonly #allowMutation: boolean
  readonly #instructions: string
  readonly #mode: ResolvedMode
  readonly #maxResponseChars: number
  readonly #rateLimit: RateLimitOptions | undefined
  readonly #auth: ResolvedAuth | undefined
  #httpHandler?: McpHttpHandler

  constructor(app: OpenAPIHono<any>, opts: BridgeOptions = {}) {
    const mode = opts.mode ?? 'auto'
    if (!['auto', 'simple', 'progressive'].includes(mode)) {
      throw new HonoGqlMcpConfigError(`mode must be 'auto' | 'simple' | 'progressive', got '${mode}'`)
    }
    const progressiveThreshold = opts.progressiveThreshold ?? PROGRESSIVE_THRESHOLD
    if (!Number.isInteger(progressiveThreshold) || progressiveThreshold < 1) {
      throw new HonoGqlMcpConfigError(`progressiveThreshold must be a positive integer, got ${progressiveThreshold}`)
    }
    const maxResponseChars = opts.maxResponseChars ?? 1_000_000
    if (!Number.isInteger(maxResponseChars) || maxResponseChars < 1) {
      throw new HonoGqlMcpConfigError(`maxResponseChars must be a positive integer, got ${maxResponseChars}`)
    }
    if (opts.rateLimit && (!Number.isInteger(opts.rateLimit.maxPerSecond) || opts.rateLimit.maxPerSecond < 1)) {
      throw new HonoGqlMcpConfigError(`rateLimit.maxPerSecond must be a positive integer`)
    }
    // Resolve auth before anything else is derived — bad combinations fail fast.
    const auth = opts.auth ? resolveAuth(opts.auth) : undefined

    this.#name = opts.name ?? 'hono-app'
    this.#version = opts.version ?? '0.1.0'
    this.#allowMutation = opts.allowMutation ?? false
    this.handler = new RouterGraphQLHandler(app, {
      allowMutation: this.#allowMutation,
      passthroughHeaders: opts.passthroughHeaders,
      include: opts.include,
      exclude: opts.exclude,
      includeTags: opts.includeTags,
      excludeTags: opts.excludeTags,
      excludeDeprecated: opts.excludeDeprecated,
      ...(opts.mutationInclude ? { mutationInclude: opts.mutationInclude } : {}),
      requestTimeoutMs: opts.requestTimeoutMs,
      maxConcurrency: opts.maxConcurrency,
      maxDepth: opts.maxDepth,
      documentCacheSize: opts.documentCacheSize,
    })
    this.#mode = mode === 'auto' ? (this.handler.routeCount > progressiveThreshold ? 'progressive' : 'simple') : mode
    this.resolvedMode = this.#mode
    this.#maxResponseChars = maxResponseChars
    this.#rateLimit = opts.rateLimit
    this.#auth = auth
    this.#instructions =
      opts.instructions ??
      [
        `Service exposed as GraphQL${this.#allowMutation ? ' (reads and writes)' : ' (read-only)'}.`,
        this.handler.domains.length > 0 ? `Domains: ${this.handler.domains.join(', ')}.` : '',
        this.#mode === 'progressive'
          ? 'Large API: browse with list_domains, then list_queries(domain), then get_query_schema(domain).'
          : 'Call get_schema once.',
        'Then compose several routes in a single graphql_query — a failing route nulls only its own field.' +
          (this.#allowMutation ? ' Writes go through graphql_mutation.' : ''),
      ]
        .filter(Boolean)
        .join(' ')

    if (this.handler.skips.length > 0) {
      console.warn(
        `[${this.#name}] skipped ${this.handler.skips.length} route(s); handler.readiness().skips lists them with reasons:`,
      )
      for (const s of this.handler.skips) console.warn(`  ${s.method} ${s.path} — ${s.reason}`)
    }
    const degradedTotal = this.handler.degraded.length + this.handler.degradedFields.length
    if (degradedTotal > 0) {
      console.warn(
        `[${this.#name}] bridged ${degradedTotal} shape(s) as raw JSON ` +
          '(no per-field selection there); handler.readiness() names them:',
      )
      for (const d of this.handler.degraded) console.warn(`  ${d.method} ${d.path} (${d.field}) — ${d.reason}`)
      for (const [where, reason] of this.handler.degradedFields) console.warn(`  ${where} — ${reason}`)
    }
    if (this.#mode === 'progressive') {
      console.warn(
        `[${this.#name}] ${this.handler.routeCount} routes (threshold ${progressiveThreshold}) — ` +
          'progressive disclosure: list_domains → list_queries → get_query_schema → graphql_query.',
      )
    }
  }

  /**
   * Serve the MCP endpoint (streamable HTTP) on a Hono app. Call AFTER all
   * routes are registered — Hono builds its route matcher on first request
   * and rejects later registrations.
   */
  mountTo(app: HonoType<any, any, any>, path = '/mcp'): void {
    this.#httpHandler ??= buildMcpHandler(this.handler, {
      name: this.#name,
      version: this.#version,
      instructions: this.#instructions,
      allowMutation: this.#allowMutation,
      mode: this.#mode,
      maxResponseChars: this.#maxResponseChars,
      ...(this.#auth?.toolScopes ? { toolScopes: this.#auth.toolScopes } : {}),
    })
    mountMcp(app, this.#httpHandler, path, this.#rateLimit, this.#auth)
  }

  /** Mount the plain-GraphQL HTTP face: POST /graphql + GET /graphiql (shares the passthrough whitelist). */
  mountGraphQL(app: HonoType<any, any, any>, opts: GraphqlMountOptions = {}): void {
    mountGraphQL(app, this.handler, opts)
  }

  /**
   * Serve the MCP endpoint standalone on its own port (in-process route calls
   * still go to the wrapped app). Needs `@hono/node-server` — install it
   * separately; the bridge itself stays runtime-agnostic.
   */
  async run(opts: { port?: number; host?: string } = {}): Promise<{ close: () => Promise<void> }> {
    let serve: (typeof import('@hono/node-server'))['serve']
    try {
      ;({ serve } = await import('@hono/node-server'))
    } catch {
      throw new HonoGqlMcpConfigError('run() needs @hono/node-server — npm i @hono/node-server')
    }
    const app = new Hono()
    this.mountTo(app, '/mcp')
    const server = serve({ fetch: app.fetch, port: opts.port ?? 8000, hostname: opts.host ?? '127.0.0.1' })
    return {
      close: () =>
        new Promise<void>((resolve, reject) => server.close((err?: Error | null) => (err ? reject(err) : resolve()))),
    }
  }
}

export { RouterGraphQLHandler, documentDepth } from './handler.ts'
export { GraphQLJSON } from './zod-to-graphql.ts'
export { LruCache } from './lru.ts'
export { DomainRegistry, domainsFor } from './domains.ts'
export { bridgeValidator, VALIDATOR_SCHEMA } from './zvalidator.ts'
export type { BridgeValidatorOptions, ValidatorTarget, ValidatorAttachment } from './zvalidator.ts'
export type { AuthOptions, AuthDiscoveryOptions, ResolvedAuth } from './auth.ts'
export type { SkipRecord, DegradedRecord } from './schema-builder.ts'
export type { ReadinessReport } from './handler.ts'
export type { ToolMode, ResolvedMode, RateLimitOptions } from './mcp.ts'
export type { AuthInfo } from '@modelcontextprotocol/server'
