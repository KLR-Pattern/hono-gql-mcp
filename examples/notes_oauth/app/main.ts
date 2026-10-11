/**
 * App assembly: OAuth auth + protected notes + hono-gql-mcp mounts — the
 * port of app/main.py. The library call is the last block; the rest is a
 * plain OpenAPIHono app.
 *
 * Credentials flow per caller, no shared service token:
 * - browser    → demo_session cookie (GitHub login)
 * - MCP client → a Bearer token minted from the browser session
 *   (POST /auth/token); the caller's Authorization header is forwarded into
 *   every route call and resolved by app/credentials.
 *
 * Delta vs the Python demo: fastmcp's GitHub OAuth proxy (interactive
 * MCP-client browser login) has no TS counterpart — the @modelcontextprotocol
 * SDK is Resource-Server-side only. Here the SAME signed session string
 * verifies at the MCP gate (auth.verifyToken) AND at the routes — one token,
 * two checks, the README's "bring your own IdP" wiring.
 */
import { serve } from '@hono/node-server'
import { pathToFileURL } from 'node:url'
import { OpenAPIHono } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { HonoGqlMcp } from '../../../src/index.ts'
import { BASE_URL, oauthConfigured } from './config.ts'
import { registerAuthRoutes } from './auth-routes.ts'
import { registerNotesRoutes } from './notes-routes.ts'
import { decodeSession } from './session.ts'

export function createApp() {
  const app = new OpenAPIHono()

  // FastAPI's HTTPException shape: thrown 401/404/… answer as {detail}.
  app.onError((err, c) => {
    if (err instanceof HTTPException) {
      return c.json({ detail: err.message }, err.status)
    }
    console.error(err)
    return c.json({ detail: 'internal server error' }, 500)
  })

  registerAuthRoutes(app)
  registerNotesRoutes(app)

  // The OpenAPI document (FastAPI serves /docs; no swagger-ui dependency here).
  app.get('/openapi.json', (c) =>
    c.json(app.getOpenAPIDocument({ openapi: '3.1.0', info: { title: 'hono-gql-mcp demo', version: '0.1.0' } })),
  )

  // The MCP gate: the session string verifies (signature + expiry), the
  // GitHub identity becomes the clientId. Unset GitHub creds → open /mcp,
  // mirroring the Python demo's fallback.
  const mcpAuth = oauthConfigured()
    ? {
        verifyToken: (token: string) => {
          const session = decodeSession(token)
          return session
            ? { token, clientId: session.login, scopes: ['mcp'], expiresAt: session.exp }
            : null
        },
      }
    : undefined

  const mcp = new HonoGqlMcp(app, {
    name: 'notes-demo',
    allowMutation: true,
    exclude: ['/auth/token'], // credential-minting is protocol, not business
    passthroughHeaders: ['authorization', 'cookie'],
    ...(mcpAuth ? { auth: mcpAuth } : {}),
  })
  mcp.mountTo(app, '/mcp')
  mcp.mountGraphQL(app) // POST /graphql + GraphiQL at /graphiql

  return { app, mcp }
}

// ---- serve when run directly ------------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { app } = createApp()
  const port = Number(BASE_URL.split(':').pop() ?? 8020)
  serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
    console.log(`
  hono-gql-mcp demo (notes-oauth)
  ─────────────────────────────────────────────────────
  Home / login:           http://localhost:${port}/auth/
  OpenAPI document:       http://localhost:${port}/openapi.json
  GraphiQL:               http://localhost:${port}/graphiql
  MCP (streamable HTTP):  http://localhost:${port}/mcp
  ─────────────────────────────────────────────────────
  GitHub OAuth configured:  ${oauthConfigured()}
  MCP endpoint:             ${oauthConfigured() ? 'gated (Bearer = POST /auth/token output)' : 'open (no GitHub creds)'}
  (The better-auth example — a full OAuth 2.1 AS from one library — is
   examples/notes/, npm run example. This one is the Python-parity port.)
  (Ctrl-C to stop)
`)
  })
}
