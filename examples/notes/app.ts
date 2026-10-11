/**
 * Demo app — a small notes service with GitHub login and an MCP endpoint
 * behind OAuth 2.1, built on the Hono+Zod → GraphQL → MCP bridge.
 * Mirrors examples/notes_oauth of fastapi-gql-mcp.
 *
 *   npm run example        # REST + GraphQL + MCP on :8020
 *   npm test               # in-process end-to-end walkthrough
 *
 * One Bearer, two checks: the bridge gate verifies the ENDPOINT (401/403 with
 * OAuth discovery), and the same token — or the session cookie — reaches the
 * routes through per-caller passthrough, where the app verifies the BUSINESS
 * CALL. The bridge holds no credentials of its own.
 *
 * createApp() is async and side-effect free at import: it opens the store, runs
 * better-auth's migrations, and reads the AS metadata — all per call. Tests call
 * it many times; nothing is shared through module state.
 */
import { serve } from '@hono/node-server'
import { pathToFileURL } from 'node:url'
import { OpenAPIHono } from '@hono/zod-openapi'
import { swaggerUI } from '@hono/swagger-ui'
import type { Context, Next } from 'hono'
import { httpInstrumentationMiddleware } from '@hono/otel'
import { HonoGqlMcp } from '../../src/index.ts'
import { createAuth, type Auth } from './auth.ts'
import {
  BASE_URL,
  BETTER_AUTH_SECRET,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  MCP_RESOURCE,
  OUTBOUND_PROXY,
  PORT,
  githubConfigured,
  MCP_RATE_LIMIT,
  otelEnabled,
  secretIsDefault,
} from './config.ts'
import { consentPageHtml, landingPageHtml, loginPageHtml } from './pages.ts'
import { registerRoutes, type Env } from './routes.ts'
import { createStore, type Store } from './store.ts'

export interface CreateAppOptions {
  /** Route-level tracing. Defaults to the HONO_GQL_MCP_OTEL env switch. */
  otel?: boolean
}

export interface App {
  app: OpenAPIHono<Env>
  bridge: HonoGqlMcp
  store: Store
  auth: Auth
}

/**
 * Paths that answer without a caller. The MCP and GraphQL patterns end on a
 * word boundary, so `/mcp`, `/mcp/1` and a sibling mount `/mcp-open` all match
 * while `/mcpfoo` does not — a bare `/^\/mcp/` prefix would have matched it.
 */
const PUBLIC = [
  /^\/$/,
  /^\/auth\//,
  /^\/api\/auth\//,
  /^\/oauth2\//,
  /^\/\.well-known\//,
  /^\/(?:graphql|graphiql)\b/,
  /^\/mcp\b/,
  /^\/categories$/,
  /^\/(?:docs|openapi\.json)$/,
]

export async function createApp(options: CreateAppOptions = {}): Promise<App> {
  const app = new OpenAPIHono<Env>()

  // Optional route-level tracing (@hono/otel extracts the W3C traceparent the
  // bridge injects into every in-process route call, so route spans nest under
  // graphql.execute). Without a registered OTel SDK both sides are no-ops — see
  // the README's Observability section. Registered FIRST: Hono middleware
  // registered after a handler does not wrap it.
  if (options.otel ?? otelEnabled()) {
    // @hono/otel types its middleware against a bare Hono Env; the cast bridges
    // that to this app's Variables without widening what the routes see.
    app.use(httpInstrumentationMiddleware({ serviceName: 'notes-api' }) as never)
  }

  const store = createStore()

  // better-auth: browser login + the OAuth 2.1 AS, one handler. It runs its
  // migrations against the store's database handle — one file, one connection.
  const auth = await createAuth({
    baseUrl: BASE_URL,
    secret: BETTER_AUTH_SECRET,
    github: githubConfigured ? { clientId: GITHUB_CLIENT_ID, clientSecret: GITHUB_CLIENT_SECRET } : null,
    mcpResource: MCP_RESOURCE,
    outboundProxy: OUTBOUND_PROXY,
    database: store.db,
  })

  // Everything the OAuth server needs (authorize, token, register, jwks,
  // well-known discovery) is served under /api/auth/*. Registered FIRST so no
  // later catch-all can shadow it.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw))

  // ---- pages the OAuth server hands the browser ----------------------------
  app.get('/', (c) => c.html(landingPageHtml(BASE_URL, githubConfigured)))
  app.get('/auth/login', (c) => c.html(loginPageHtml(githubConfigured)))
  app.get('/auth/consent', (c) => c.html(consentPageHtml(new URL(c.req.url).searchParams)))

  // ---- auth middleware: resolve the caller, gate the business routes -------
  // Public paths answer without a caller AND without a session lookup; only a
  // gated route pays for token/session verification. In-process GraphQL/MCP
  // calls run through this middleware too (the executor calls app.request()),
  // so the passthrough headers decide the caller there exactly as a browser
  // cookie does over HTTP.
  app.use('*', async (c: Context<Env>, next: Next) => {
    if (PUBLIC.some((re) => re.test(c.req.path))) return next()
    const caller = await auth.resolveUser(c.req.raw)
    if (!caller) return c.json({ error: 'unauthorized' }, 401)
    c.set('caller', caller)
    await next()
  })

  registerRoutes(app, store)

  // ---- REST docs: OpenAPI 3.1 document + Swagger UI ------------------------
  // The document is derived from the SAME createRoute() definitions the bridge
  // reads — one source, two views (Swagger for humans, GraphQL for agents).
  // `/docs` is public so the tour starts before login; the try-it-out calls
  // still answer 401 until a session cookie or Bearer is present.
  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'notes-api',
      version: '0.1.0',
      description: 'Demo REST surface — the same routes the GraphQL/MCP bridge derives from.',
    },
    tags: [{ name: 'notes' }, { name: 'analytics' }, { name: 'catalog:tree' }],
  })
  app.get('/docs', swaggerUI({ url: '/openapi.json' }))

  // ---- bridge: GraphQL + MCP over the same routes --------------------------
  const bridge = new HonoGqlMcp(app, {
    name: 'notes-api',
    allowMutation: true,
    passthroughHeaders: ['authorization', 'cookie'],
    // Caps a token-spray against the gate (each rejection also warns once per
    // minute in auth.ts — together they bound both the request flood and the
    // log flood a bad client can cause).
    rateLimit: { maxPerSecond: MCP_RATE_LIMIT },
    instructions:
      'Notes service exposed as GraphQL (reads and writes). Domains: notes, analytics, catalog. ' +
      'Call get_schema once, then compose routes in a single graphql_query — a failing route nulls ' +
      'only its own field. Writes go through graphql_mutation. You only see notes you own.',
    // With GitHub configured the MCP endpoint is OAuth-gated; without it the
    // endpoint stays open so the demo runs from a blank .env.
    ...(githubConfigured
      ? {
          auth: {
            verifyToken: auth.verifyToken,
            // Advertised in the 401 challenge so the client can discover the AS.
            resourceMetadataUrl: `${BASE_URL}/.well-known/oauth-protected-resource/mcp`,
            discovery: {
              resourceServerUrl: MCP_RESOURCE,
              resourceName: 'notes-api MCP',
              authorizationServerMetadata: auth.asMetadata,
            },
          },
        }
      : {}),
  })
  bridge.mountTo(app, '/mcp')
  bridge.mountGraphQL(app) // POST /graphql + GraphiQL at /graphiql

  return { app, bridge, store, auth }
}

// ---- serve when run directly --------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  if (secretIsDefault) {
    console.warn('[config] BETTER_AUTH_SECRET is the dev default — set a random one before exposing this server.')
  }
  const { app, bridge, store } = await createApp()
  const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`notes-api demo`)
    console.log(`  REST     http://localhost:${info.port}/categories  (public)`)
    console.log(`  Docs     http://localhost:${info.port}/docs        (Swagger UI)`)
    console.log(`  Login    http://localhost:${info.port}/          (GitHub${githubConfigured ? '' : ' — not configured'})`)
    console.log(`  GraphQL  http://localhost:${info.port}/graphiql`)
    console.log(
      `  MCP      http://localhost:${info.port}/mcp  ${githubConfigured ? '(OAuth 2.1 gated)' : '(open — no GitHub creds)'}`,
    )
    console.log(`\nDerived GraphQL schema (${bridge.handler.domains.length} domains):\n`)
    console.log(`  (The fastapi-gql-mcp notes_oauth port — hand-rolled auth for Python-parity\n   verification — lives in examples/notes_oauth, npm run example:oauth.)`)
    console.log(bridge.handler.getSDL())
  })

  // Close the HTTP server and the database before exit, so WAL is checkpointed
  // and the sqlite file is left clean.
  let shuttingDown = false
  const shutdown = async (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`\n${signal} — shutting down`)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    store.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
