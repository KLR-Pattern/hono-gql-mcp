/**
 * Auth: browser GitHub login + the MCP OAuth 2.1 Authorization Server, both
 * from better-auth. One library, one handler, mounted at /api/auth/*.
 *
 *   browser    ──GitHub social login──▶ better-auth session cookie
 *   MCP client ──401 challenge──discovery──▶ /oauth2/authorize → token (JWT)
 *
 * The bridge is Resource-Server-side only (src/auth.ts): it needs a token
 * verifier and discovery metadata. This module supplies both:
 *   - verifyToken  → the bridge gate (401/403 challenges)
 *   - resolveUser  → the routes' own check (per-caller passthrough)
 * One Bearer, two checks — exactly the Python example's shape.
 *
 * Everything is built by `createAuth(cfg)`. Importing this module has NO side
 * effect: no process-global fetch patch, no migrations, no discovery fetch.
 * Those ran at import time before, which made the module untestable and let two
 * importers each run migrations against the same file.
 */
import { betterAuth, type BetterAuthOptions } from 'better-auth'
import { jwt } from 'better-auth/plugins'
import { verifyJwsAccessToken } from 'better-auth/oauth2'
import { getMigrations } from 'better-auth/db/migration'
import { mcp } from '@better-auth/mcp'
import { cimd } from '@better-auth/cimd'
import type Database from 'better-sqlite3'
import type { ProxyAgent } from 'undici'
import type { AuthInfo, OAuthMetadata } from '@modelcontextprotocol/server'

/** The business caller a route acts for. */
export interface Caller {
  id: string
  name: string
}

export interface AuthConfig {
  /** Public base URL — becomes better-auth's `baseURL` and the discovery issuer base. */
  baseUrl: string
  /** Signs sessions and tokens. */
  secret: string
  /** GitHub creds, or null to disable social login (and the MCP OAuth gate with it). */
  github: { clientId: string; clientSecret: string } | null
  /** RFC 8707 / 9728 resource identifier — the canonical MCP endpoint URL. */
  mcpResource: string
  /** Optional egress proxy for outbound fetches. Empty = direct. */
  outboundProxy: string
  /** The shared better-auth database — the SAME handle the app's store uses. */
  database: Database.Database
}

/** What createAuth hands back to the app. */
export interface Auth {
  /** The better-auth request handler — mount at /api/auth/*. */
  handler: (request: Request) => Promise<Response>
  /** AS metadata read from better-auth (issuer is `${baseUrl}/api/auth`, not the app root). */
  asMetadata: OAuthMetadata
  /** Bridge gate: verify an access token and describe the caller. Null → the gate answers 401. */
  verifyToken: (token: string) => Promise<AuthInfo | null>
  /** Route-level check: the Bearer's `sub` claim, else the session cookie, else null. */
  resolveUser: (request: Request) => Promise<Caller | null>
  /** Mint a signed access token. Tests/scripts only — real clients use /oauth2/token. */
  signToken: (sub: string, extra?: Record<string, unknown>) => Promise<string>
}

// ---- outbound fetch: optional egress proxy + CIMD SSRF guard ------------------

/**
 * Warn at most once per minute per site. A client spraying bad tokens at the
 * gate must not grow the log unboundedly — the bridge's rateLimit caps the
 * request flood, this caps the log lines (and keeps one visible sample of
 * each failure mode for operators).
 */
const throttledWarn = (() => {
  const last = new Map<string, number>()
  return (site: string, err: unknown): void => {
    const now = Date.now()
    if (now - (last.get(site) ?? 0) < 60_000) return
    last.set(site, now)
    console.warn(`[auth] ${site}:`, err instanceof Error ? err.message : err)
  }
})()

/** One ProxyAgent per process; reused so every proxied call shares the pool. */
let proxyAgentPromise: Promise<ProxyAgent> | undefined
function proxyAgentFor(url: string): Promise<ProxyAgent> {
  proxyAgentPromise ??= import('undici').then(({ ProxyAgent }) => new ProxyAgent(url))
  return proxyAgentPromise
}

const isLoopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '::1'

/**
 * Process-global: when a proxy is configured, replace globalThis.fetch with a
 * proxy-dispatched version. This is the single point that fixes EVERY
 * server-side outbound call — better-auth's GitHub token exchange and user
 * fetches go through betterFetch → globalThis.fetch (it offers no per-request
 * dispatcher). Node's fetch otherwise ignores http_proxy/https_proxy entirely.
 * The patch is idempotent (guarded by `__originalFetch`) and a no-op when no
 * proxy is set. Loopback stays direct: the app calling itself must not leave
 * the host.
 */
async function installProxyFetch(proxyUrl: string): Promise<void> {
  if (!proxyUrl || globalThis.__originalFetch) return
  const original = globalThis.fetch.bind(globalThis)
  globalThis.__originalFetch = original
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const target = new URL(url, 'http://localhost')
    if (isLoopback(target.hostname)) return original(input, init)
    const { fetch: undiciFetch } = await import('undici')
    return undiciFetch(url, { ...init, dispatcher: await proxyAgentFor(proxyUrl) } as never) as unknown as Response
  }) as typeof fetch
}

/**
 * SSRF guard for CIMD: the client supplies an arbitrary metadata-document URL,
 * so the fetch must not become a probe into the private network. https only,
 * no IP-literal or localhost hosts. (A production guard also pins resolved
 * addresses — see the better-auth CIMD docs on SSRF protection.)
 */
async function safeClientMetadataFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  proxyUrl: string,
): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
  if (url.protocol !== 'https:') throw new Error(`CIMD: refusing non-https client metadata URL (${url.protocol})`)
  const host = url.hostname.toLowerCase()
  const isIpLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || isIpLiteral) {
    throw new Error(`CIMD: refusing private-host client metadata URL (${host})`)
  }
  if (!proxyUrl) return fetch(url, init)
  const { fetch: undiciFetch } = await import('undici')
  const res = await undiciFetch(url, { ...init, dispatcher: await proxyAgentFor(proxyUrl) } as never)
  return res as unknown as Response
}

// ---- factory -----------------------------------------------------------------

/**
 * Plugin endpoints (jwt: getJwks / signJWT) exist at runtime but
 * `betterAuth()`'s inferred `api` type does not surface them, so name the two
 * this example uses. Both are also reachable over HTTP at /api/auth/jwks and
 * /api/auth/token — the local path just avoids a round trip to ourselves.
 */
interface JwtApi {
  getJwks: () => Promise<{ keys: JsonWebKey[] }>
  signJWT: (opts: { body: { payload: Record<string, unknown> } }) => Promise<{ token: string }>
  getOAuthServerConfig: () => Promise<OAuthMetadata>
}

export async function createAuth(cfg: AuthConfig): Promise<Auth> {
  await installProxyFetch(cfg.outboundProxy)

  const authOptions: BetterAuthOptions = {
    baseURL: cfg.baseUrl,
    secret: cfg.secret,
    trustedOrigins: [cfg.baseUrl],
    ...(cfg.github
      ? { socialProviders: { github: { clientId: cfg.github.clientId, clientSecret: cfg.github.clientSecret } } }
      : {}),
    plugins: [
      jwt(),
      // The MCP plugin IS the OAuth 2.1 provider: /oauth2/authorize|token|register,
      // RFC 8414 + 9728 discovery, PKCE. `resource` binds issued tokens by audience.
      mcp({
        resource: cfg.mcpResource,
        loginPage: '/auth/login',
        consentPage: '/auth/consent',
        // MCP clients (Claude Code et al.) still register dynamically; CIMD is
        // the modern path, DCR the compatibility fallback. Registration is
        // unauthenticated — the client has no credentials yet, that is the point.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      // Client ID Metadata Documents (mcp-2026-07-28) — the recommended client
      // identity mechanism when the client supports it.
      cimd({
        fetchClientMetadataResource: (input, init) => safeClientMetadataFetch(input, init, cfg.outboundProxy),
        metadataProfile: 'mcp-2026-07-28',
      }),
    ],
  }

  // The database rides ON the options object: `getMigrations` re-derives its
  // own kysely handle from the config, and `betterAuth()` wraps the same
  // instance for runtime queries. Tables are created by better-auth's own
  // migration runner (`getMigrations` — the programmatic form of
  // `npx auth migrate`), so the schema always matches the plugin set.
  const dbOptions: BetterAuthOptions = { ...authOptions, database: cfg.database }
  const { runMigrations } = await getMigrations(dbOptions)
  await runMigrations()

  const auth = betterAuth(dbOptions)
  const authApi = auth.api as typeof auth.api & JwtApi

  /**
   * The authorization-server metadata, read from better-auth rather than
   * hardcoded — the issuer is `${baseURL}/api/auth` (not the app root) and the
   * endpoints live under it. Handing the real document to the bridge keeps the
   * RFC 8414 copy it serves identical to the one better-auth serves itself.
   */
  const asMetadata: OAuthMetadata = await authApi.getOAuthServerConfig()

  /**
   * Verify a better-auth access token: signature, issuer, audience (aud = MCP
   * resource). The JWKS is read straight from the auth instance — no HTTP round
   * trip to ourselves, so verification works with no server running (tests) and
   * never deadlocks a single-threaded process. The issuer is the one the AS
   * metadata advertises (`${BASE_URL}/api/auth`, basePath included), NOT the
   * bare base URL; hardcoding BASE_URL rejected every real client token at the
   * iss assertion ("rejected them on reconnect").
   */
  const verifyClaims = (token: string): Promise<Record<string, unknown>> =>
    verifyJwsAccessToken(token, {
      jwksFetch: () => authApi.getJwks(),
      jwksCacheKey: auth,
      verifyOptions: { issuer: asMetadata.issuer, audience: cfg.mcpResource },
    }) as Promise<Record<string, unknown>>

  const bearerToken = (request: Request): string | null => {
    const header = request.headers.get('authorization')
    return header?.startsWith('Bearer ') ? header.slice(7) : null
  }

  return {
    handler: (request) => auth.handler(request),

    asMetadata,

    async verifyToken(token) {
      let claims: Record<string, unknown>
      try {
        claims = await verifyClaims(token)
      } catch (err) {
        throttledWarn('gate rejected a bearer', err)
        return null
      }
      const scope = typeof claims.scope === 'string' ? claims.scope : ''
      return {
        token,
        clientId: String(claims.client_id ?? claims.sub ?? 'unknown'),
        scopes: scope.split(' ').filter(Boolean),
        expiresAt: typeof claims.exp === 'number' ? claims.exp : Math.floor(Date.now() / 1000) + 3600,
      }
    },

    /**
     * Resolve the business caller for a route: the Bearer's `sub` claim (verified
     * here too — the routes are their own check), else the better-auth session
     * cookie. Returns null when anonymous. A malformed or expired Bearer is
     * logged so operators can tell "bad token" from "nobody signed in" — both
     * still answer 401, but only one is a client bug.
     */
    async resolveUser(request) {
      const token = bearerToken(request)
      if (token) {
        try {
          const claims = await verifyClaims(token)
          const id = String(claims.sub ?? '')
          if (!id) return null
          return { id, name: String(claims.name ?? claims.preferred_username ?? id) }
        } catch (err) {
          throttledWarn('route check rejected a bearer', err)
          return null
        }
      }
      const session = await auth.api.getSession({ headers: request.headers })
      if (!session?.user) return null
      return { id: session.user.id, name: session.user.name || session.user.email || session.user.id }
    },

    async signToken(sub, extra = {}) {
      const { token } = await authApi.signJWT({
        body: { payload: { sub, aud: cfg.mcpResource, iss: asMetadata.issuer, ...extra } },
      })
      return token
    },
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __originalFetch: typeof fetch | undefined
}
