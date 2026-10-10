/**
 * MCP face — a constant tool set over the bridged schema.
 *
 * Simple mode: get_schema + graphql_query (+ graphql_mutation) — one-shot
 * discovery for small apps.
 * Progressive mode (mode='progressive', or mode='auto' above
 * progressiveThreshold routes): a 4-layer walkthrough of the tag tree —
 *   list_domains → list_queries(domain) → get_query_schema(domain) → graphql_query
 *   (+ list_mutations when writes are on; get_schema is NOT registered)
 * Discovery is scoped; execution is not — graphql_query always runs against
 * the full schema, so fields from different domains combine freely.
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
import { z } from 'zod'
import { GraphQLError, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, parse, printSchema, type GraphQLFieldConfig, type GraphQLObjectType as ObjType, type GraphQLType } from 'graphql'
import type { RouterGraphQLHandler } from './handler.ts'
import { groupTypeName } from './schema-builder.ts'
import type { ResolvedAuth } from './auth.ts'
import { withToolSpan, type EnvelopeTrace } from './otel.ts'

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

function operationTypeOf(query: string): 'query' | 'mutation' | 'subscription' | null {
  const doc = parse(query)
  for (const def of doc.definitions) {
    if (def.kind === 'OperationDefinition') return def.operation
  }
  return null
}

const limitText = (text: string, max: number): string =>
  text.length > max
    ? `${text.slice(0, max)}\n…[truncated — tool result exceeded maxResponseChars (${text.length} > ${max})]`
    : text

// ---- progressive disclosure ---------------------------------------------------

const parseDomain = (domain: string): string[] =>
  domain
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)

function fieldBrief(name: string, field: GraphQLFieldConfig<unknown, unknown>): Record<string, unknown> {
  const args = Object.entries(field.args ?? {}).map(([argName, arg]) => ({
    name: argName,
    type: String(arg.type),
    ...(arg.description ? { description: arg.description } : {}),
  }))
  return {
    name,
    type: String(field.type),
    ...(field.description ? { description: field.description } : {}),
    ...(field.deprecationReason ? { deprecated: true } : {}),
    ...(args.length > 0 ? { args } : {}),
  }
}

const unwrapType = (t: GraphQLType): GraphQLType => (t instanceof GraphQLNonNull ? t.ofType : t)

/** The group object type sitting at `path` under a root operation type. */
function walkGroup(root: ObjType | null | undefined, path: string[]): ObjType | null {
  let current: GraphQLType | null | undefined = root ?? undefined
  for (const seg of path) {
    if (!(current instanceof GraphQLObjectType)) return null
    const field = current.getFields()[seg]
    if (!field) return null
    current = unwrapType(field.type)
  }
  return current instanceof GraphQLObjectType ? current : null
}

/**
 * SDL fragment for one domain subtree, addressed exactly as in queries.
 * Re-wraps the schema's real group object up the ancestor chain with
 * sibling-free wrappers that KEEP the real group names, so the fragment's
 * field addresses match the schema while printSchema auto-collects only the
 * reachable types. (Port of the Python bridge's _domain_sdl.)
 */
function domainSdl(handler: RouterGraphQLHandler, path: string[]): string | null {
  const { queries, mutations } = handler.registry.subtreeFields(path)
  if (queries.length === 0 && mutations.length === 0) return null

  const wrap = (root: ObjType | null | undefined, kind: 'query' | 'mutation'): ObjType | null => {
    const group = walkGroup(root, path)
    if (!group) return null
    let current: ObjType = group
    for (let depth = path.length - 1; depth >= 1; depth--) {
      const ancestors = path.slice(0, depth)
      const childSeg = path[depth]
      current = new GraphQLObjectType({
        name: groupTypeName(ancestors, kind),
        fields: { [childSeg]: { type: new GraphQLNonNull(current) } },
      })
    }
    return current
  }

  const subQueryObj = wrap(handler.schema.getQueryType(), 'query')
  if (!subQueryObj) return null
  const subQuery = new GraphQLObjectType({
    name: 'Query',
    fields: { [path[0]]: { type: new GraphQLNonNull(subQueryObj) } },
  })
  let subMutation: ObjType | undefined
  if (mutations.length > 0 && handler.schema.getMutationType()) {
    const m = wrap(handler.schema.getMutationType(), 'mutation')
    if (m) {
      subMutation = new GraphQLObjectType({
        name: 'Mutation',
        fields: { [path[0]]: { type: new GraphQLNonNull(m) } },
      })
    }
  }
  return printSchema(new GraphQLSchema({ query: subQuery, ...(subMutation ? { mutation: subMutation } : {}) }))
}

// ---- tool registration --------------------------------------------------------

interface Envelope {
  success: boolean
  data?: unknown
  hint?: string
  error?: string
  error_type?: string
}

const ok = (data: unknown, hint?: string): Envelope => ({ success: true, data, ...(hint ? { hint } : {}) })
const err = (error: string, errorType: string, hint?: string): Envelope => ({
  success: false,
  error,
  error_type: errorType,
  ...(hint ? { hint } : {}),
})

const unknownDomain = (handler: RouterGraphQLHandler, domain: string): Envelope => {
  const available = handler.registry
    .summary()
    .map((s) => s.path.join(':'))
    .join(', ')
  return err(`Unknown domain '${domain}'.`, 'DOMAIN_NOT_FOUND', `Available top-level domains: ${available}. Use list_domains to browse the full tree.`)
}

export function buildMcpHandler(handler: RouterGraphQLHandler, opts: McpFaceOptions): McpHttpHandler {
  // The schema is immutable after build, so each domain's SDL fragment is
  // computed once per handler and reused across requests. The SDK factory
  // below runs PER REQUEST (stateless serving) — this cache must live
  // outside it, or every get_query_schema would rebuild and re-print the
  // fragment from scratch.
  const sdlCache = new Map<string, string>()
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
    const cap = opts.maxResponseChars
    const text = (payload: unknown) => limitText(JSON.stringify(payload, null, 2), cap)

    // Per-tool scope challenges: the SDK enforces them before dispatch (HTTP
    // 403 + WWW-Authenticate insufficient_scope), against the authInfo the
    // endpoint gate verified for this request.
    const scopeFor = (name: string) => {
      const scopes = opts.toolScopes?.[name]
      return scopes && scopes.length > 0 ? { scopeChallenge: requireScopes(...(scopes as [string, ...string[]])) } : {}
    }

    const runDocument = (query: string, variables: Record<string, unknown> | undefined) =>
      handler.execute(query, variables, { headers: callerHeaders })

    if (opts.mode === 'simple') {
      register(
        'get_schema',
        {
          title: 'Get the GraphQL schema',
          description:
            'The full GraphQL SDL of this service. Routes are grouped into domains by tag. ' +
            'Read this once, then compose any routes in a single graphql_query.',
          annotations: { readOnlyHint: true },
          ...scopeFor('get_schema'),
        },
        async () => ({ content: [{ type: 'text', text: text(handler.getSDL()) }] }),
      )
    } else {
      // Progressive disclosure (domain SDL fragments served from the
      // handler-level sdlCache above).
      const resolve = (domain: string): string[] | null => {
        const path = parseDomain(domain)
        return handler.registry.has(path) ? path : null
      }

      register(
        'list_domains',
        {
          title: 'List domains',
          description:
            "List the API's domains (derived from route tags) with operation counts. Domains form a tree: " +
            "tag 'billing:invoice' yields domain 'billing' with subdomain 'invoice'. Untagged routes group by " +
            "their first path segment. Start here, then drill in with list_queries(domain).",
          annotations: { readOnlyHint: true },
          ...scopeFor('list_domains'),
        },
        async () => ({
          content: [{ type: 'text', text: text(ok({ domains: handler.registry.summary() }, 'Call list_queries(domain) with one of these domain paths.')) }],
        }),
      )

      register(
        'list_queries',
        {
          title: "List a domain's Query operations",
          description:
            "List the read (Query) operations of one domain subtree — 'billing' includes its subdomains. " +
            'Each entry carries name, type, description and arguments.',
          inputSchema: z.object({
            domain: z.string().describe("Domain path from list_domains, e.g. 'billing:invoice'."),
          }),
          annotations: { readOnlyHint: true },
          ...scopeFor('list_queries'),
        },
        async ({ domain }) => {
          const path = resolve(domain)
          if (!path) return { content: [{ type: 'text', text: text(unknownDomain(handler, domain)) }] }
          const { queries } = handler.registry.subtreeFields(path)
          const fields = queries
            .filter(([owner, name]) => handler.queryFields.has(`${owner.join(':')}|${name}`))
            .sort(([a], [b]) => a.join(':').localeCompare(b.join(':')))
            .map(([owner, name]) => fieldBrief(name, handler.queryFields.get(`${owner.join(':')}|${name}`)!))
          return {
            content: [
              {
                type: 'text',
                text: text(
                  ok(
                    { domain, queries: fields },
                    'Call get_query_schema(domain) for the full SDL fragment of these operations, then graphql_query to execute.',
                  ),
                ),
              },
            ],
          }
        },
      )

      if (opts.allowMutation) {
        register(
          'list_mutations',
          {
            title: "List a domain's Mutation operations",
            description: "List the write (Mutation) operations of one domain subtree.",
            inputSchema: z.object({
              domain: z.string().describe("Domain path from list_domains, e.g. 'billing'."),
            }),
            annotations: { readOnlyHint: true },
          ...scopeFor('list_mutations'),
          },
          async ({ domain }) => {
            const path = resolve(domain)
            if (!path) return { content: [{ type: 'text', text: text(unknownDomain(handler, domain)) }] }
            const { mutations } = handler.registry.subtreeFields(path)
            const fields = mutations
              .filter(([owner, name]) => handler.mutationFields.has(`${owner.join(':')}|${name}`))
              .sort(([a], [b]) => a.join(':').localeCompare(b.join(':')))
              .map(([owner, name]) => fieldBrief(name, handler.mutationFields.get(`${owner.join(':')}|${name}`)!))
            return { content: [{ type: 'text', text: text(ok({ domain, mutations: fields })) }] }
          },
        )
      }

      register(
        'get_query_schema',
        {
          title: "Get a domain's SDL fragment",
          description:
            "The SDL fragment for one domain: its operations and every type they reach — nothing else. " +
            'Execution is NOT restricted to the domain: graphql_query runs against the full schema, ' +
            'so fields from different domains may be combined in one query.',
          inputSchema: z.object({
            domain: z.string().describe("Domain path from list_domains, e.g. 'billing:invoice'."),
          }),
          annotations: { readOnlyHint: true },
          ...scopeFor('get_query_schema'),
        },
        async ({ domain }) => {
          const path = resolve(domain)
          if (!path) return { content: [{ type: 'text', text: text(unknownDomain(handler, domain)) }] }
          const cacheKey = path.join(':')
          let sdl = sdlCache.get(cacheKey)
          if (sdl === undefined) {
            const built = domainSdl(handler, path)
            if (built === null) {
              return {
                content: [
                  {
                    type: 'text',
                    text: text(
                      err(
                        `Domain '${domain}' has no GraphQL operations.`,
                        'DOMAIN_NOT_FOUND',
                        "Pick a domain from list_domains that carries operations.",
                      ),
                    ),
                  },
                ],
              }
            }
            sdl = built
            sdlCache.set(cacheKey, sdl)
          }
          return {
            content: [
              {
                type: 'text',
                text: text(
                  ok(
                    { sdl },
                    'Write a GraphQL query against this fragment and run it with graphql_query (other domains may be combined too).',
                  ),
                ),
              },
            ],
          }
        },
      )
    }

    // ---- executor tools (both modes) ---------------------------------------
    const queryInput = z.object({
      query: z.string().describe('A GraphQL query document, e.g. { notes { list_notes { title } } }'),
      variables: z.record(z.string(), z.unknown()).optional().describe('Query variables, if the document declares any'),
    })

    register(
      'graphql_query',
      {
        title: 'Run a GraphQL query',
        description:
          'Execute a GraphQL query. Compose several routes in one document — a failing route ' +
          'nulls only its own field while siblings survive. Select only the fields you need.',
        inputSchema: queryInput,
        annotations: { readOnlyHint: true },
          ...scopeFor('graphql_query'),
      },
      async ({ query, variables }) => {
        if (operationTypeOf(query) !== 'query') {
          throw new GraphQLError('graphql_query refuses mutation documents — use graphql_mutation for writes')
        }
        const result = await runDocument(query, variables)
        return { content: [{ type: 'text', text: text(result) }] }
      },
    )

    if (opts.allowMutation) {
      register(
        'graphql_mutation',
        {
          title: 'Run a GraphQL mutation',
          description:
            'Execute a GraphQL mutation (writes). Mutation fields at the root run serially, in document order.',
          inputSchema: z.object({
            query: z.string().describe('A GraphQL mutation document'),
            variables: z.record(z.string(), z.unknown()).optional(),
          }),
          annotations: { destructiveHint: true },
          ...scopeFor('graphql_mutation'),
        },
        async ({ query, variables }) => {
          if (operationTypeOf(query) !== 'mutation') {
            throw new GraphQLError('graphql_mutation only runs mutation documents')
          }
          const result = await runDocument(query, variables)
          return { content: [{ type: 'text', text: text(result) }] }
        },
      )
    }

    return server
  })
}

// ---- rate limiting (per-process, like the Python bridge's in-memory middleware) ----

export interface RateLimitOptions {
  maxPerSecond: number
  /** Caller key; default: hash of the authorization header ('anonymous' when absent). */
  keyBy?: (request: Request) => string
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
): void {
  const limiter = rateLimit ? new FixedWindowLimiter(rateLimit.maxPerSecond) : undefined
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
      hostHeaderValidationResponse(c.req.raw, localhostAllowedHostnames()) ??
      originValidationResponse(c.req.raw, localhostAllowedOrigins())
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
