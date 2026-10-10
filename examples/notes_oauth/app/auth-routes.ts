/**
 * GitHub OAuth login flow and the session dependency — the port of
 * app/auth_routes.py. Routes are zod-openapi routes so the bridge derives
 * them exactly like the Python demo (typed /auth/me; the redirect routes
 * land in the raw-JSON bucket; /auth/token is excluded in main.ts; the home
 * page is hide:true — FastAPI's include_in_schema=False).
 */
import { randomBytes } from 'node:crypto'
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import {
  BASE_URL,
  GITHUB_AUTHORIZE_URL,
  GITHUB_CLIENT_ID,
  GITHUB_CLIENT_SECRET,
  GITHUB_TOKEN_URL,
  GITHUB_USER_URL,
  oauthConfigured,
} from './config.ts'
import { registerBearerVerifier, resolveUser, sessionStringVerifier } from './credentials.ts'
import { encodeSession, SESSION_COOKIE } from './session.ts'
import { GitHubUser } from './models.ts'

// The app's own session string verifies as a Bearer — mirrors Python's
// credentials.register_bearer_verifier(session_string_verifier).
registerBearerVerifier(sessionStringVerifier)

const STATE_COOKIE = 'oauth_state'

/** 302 with a cookie — the header is set before c.redirect() snapshots it. */
const redirectWithCookie = (
  c: Context,
  url: string,
  cookie?: { name: string; value: string; maxAge: number },
) => {
  if (cookie) {
    c.header(
      'set-cookie',
      `${cookie.name}=${encodeURIComponent(cookie.value)}; HttpOnly; Path=/; Max-Age=${cookie.maxAge}; SameSite=Lax`,
    )
  }
  return c.redirect(url, 302)
}

const sessionCookieHeader = (session: string): string =>
  `${SESSION_COOKIE}=${encodeURIComponent(session)}; HttpOnly; Path=/; Max-Age=${24 * 3600}; SameSite=Lax`

// ---- routes ----------------------------------------------------------------------

const loginRoute = createRoute({
  method: 'get',
  path: '/auth/login',
  tags: ['auth'],
  summary: 'Start the GitHub OAuth flow.',
  responses: { 302: { description: 'Redirect to GitHub authorize.' } },
})

const callbackRoute = createRoute({
  method: 'get',
  path: '/auth/callback',
  tags: ['auth'],
  summary: 'Exchange the OAuth code for the GitHub identity and open a session.',
  request: {
    query: z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }),
  },
  responses: { 302: { description: 'Redirect to /auth/me with the session cookie.' } },
})

const meRoute = createRoute({
  method: 'get',
  path: '/auth/me',
  tags: ['auth'],
  summary: 'Who am I? (public shape; returns 401 when not logged in)',
  responses: {
    200: { description: 'The logged-in identity.', content: { 'application/json': { schema: GitHubUser } } },
  },
})

// Loose-typed on purpose: the handler answers TokenOut while the route is
// excluded from the bridge anyway (exclude: ['/auth/token'] in main.ts), so
// the response schema never serves anyone.
const tokenRoute = {
  method: 'post',
  path: '/auth/token',
  tags: ['auth'],
  summary: 'Exchange the current session for a Bearer token.',
  description:
    'Same signed payload as the cookie — for MCP clients and other callers that ' +
    'authenticate with `Authorization: Bearer <token>` instead.',
  responses: { 200: { description: 'The minted token (TokenOut).' } },
} as Parameters<typeof createRoute>[0]

const logoutRoute = createRoute({
  method: 'post',
  path: '/auth/logout',
  tags: ['auth'],
  summary: 'Clear the session cookie.',
  responses: { 302: { description: 'Redirect to /.' } },
})

const HOME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>hono-gql-mcp demo</title>
<style>
 body { font-family: -apple-system, sans-serif; max-width: 40rem;
       margin: 4rem auto; line-height: 1.6; }
 code { background: #f4f4f4; padding: 0 .3rem; border-radius: 4px; }
 li { margin: .3rem 0; }
</style></head><body>
<h1>hono-gql-mcp demo</h1>
<p>A Notes API behind GitHub OAuth, exposed to agents via GraphQL + MCP.</p>
<ol>
 <li><a href="/auth/login">Login with GitHub</a> (needs <code>.env</code>)</li>
 <li><a href="/openapi.json">OpenAPI document</a> — try the protected <code>/api/notes</code></li>
 <li><a href="/graphiql">GraphiQL</a> — query
     <code>{ notes { mine { list_notes { title } } } }</code> with your session cookie</li>
 <li><a href="/mcp">MCP endpoint</a> — connect an MCP client
     (<code>Authorization: Bearer &lt;token from POST /auth/token&gt;</code>)</li>
</ol>
<p>OAuth configured: <b>{configured}</b></p>
</body></html>`

export function registerAuthRoutes(app: OpenAPIHono<any>): void {
  app.openapi(loginRoute, (c) => {
    if (!oauthConfigured()) {
      throw new HTTPException(500, {
        message:
          'GitHub OAuth not configured: set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET in .env (see .env.example)',
      })
    }
    const state = randomBytes(16).toString('base64url')
    const url =
      `${GITHUB_AUTHORIZE_URL}?client_id=${GITHUB_CLIENT_ID}` +
      `&redirect_uri=${encodeURIComponent(`${BASE_URL}/auth/callback`)}&scope=read:user&state=${state}`
    return redirectWithCookie(c, url, { name: STATE_COOKIE, value: state, maxAge: 600 })
  })

  app.openapi(callbackRoute, async (c) => {
    const { code, state, error } = c.req.valid('query')
    if (error) throw new HTTPException(400, { message: `GitHub denied: ${error}` })
    const expected = c.req.header('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${STATE_COOKIE}=`))
      ?.slice(STATE_COOKIE.length + 1)
    if (!code || !state || !expected || decodeURIComponent(state) !== decodeURIComponent(expected)) {
      throw new HTTPException(400, { message: 'invalid oauth state' })
    }

    const tokenResponse = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${BASE_URL}/auth/callback`,
      }),
    })
    const accessToken = tokenResponse.ok
      ? ((await tokenResponse.json()) as { access_token?: string }).access_token
      : undefined
    if (!accessToken) throw new HTTPException(401, { message: 'token exchange failed' })

    const userResponse = await fetch(GITHUB_USER_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json' },
    })
    if (!userResponse.ok) throw new HTTPException(401, { message: 'profile fetch failed' })
    const profile = (await userResponse.json()) as { login: string; name?: string; avatar_url?: string }

    const session = encodeSession({
      login: profile.login,
      name: profile.name ?? null,
      avatar_url: profile.avatar_url ?? null,
    })
    c.header('set-cookie', sessionCookieHeader(session))
    c.header('set-cookie', `${STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0`, { append: true })
    return c.redirect('/auth/me', 302)
  })

  app.openapi(meRoute, (c) => {
    const user = resolveUser(c.req.raw)
    if (!user) throw new HTTPException(401, { message: 'not logged in' })
    return c.json({ login: user.login, name: user.name ?? null, avatar_url: user.avatar_url ?? null }, 200)
  })

  app.openapi(tokenRoute, (c) => {
    const user = resolveUser(c.req.raw)
    if (!user) throw new HTTPException(401, { message: 'login required (/auth/login)' })
    return c.json(
      {
        access_token: encodeSession({
          login: user.login,
          name: user.name ?? null,
          avatar_url: user.avatar_url ?? null,
        }),
        token_type: 'Bearer',
      },
      200,
    )
  })

  app.openapi(logoutRoute, (c) => {
    c.header('set-cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`)
    return c.redirect('/', 302)
  })

  app.get('/auth/', (c) => c.html(HOME_HTML.replace('{configured}', String(oauthConfigured()))))
}
