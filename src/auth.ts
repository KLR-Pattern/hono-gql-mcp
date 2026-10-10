/**
 * MCP endpoint auth — the Protected Resource side, on SDK primitives.
 *
 * The gate (SDK `requireBearerAuth`) verifies a Bearer token on every request
 * to the MCP endpoint: failures answer 401 `invalid_token` / 403
 * `insufficient_scope` with a `WWW-Authenticate: Bearer` challenge (carrying
 * `resource_metadata` when configured, per RFC 9728). The verified AuthInfo
 * flows to the per-request server factory and to per-tool scope challenges.
 *
 * Same rule as the Python bridge: the bridge itself never verifies business
 * credentials — that stays with the routes (per-caller passthrough). One
 * Bearer, two checks: the gate verifies the ENDPOINT, the routes' own
 * security schemes verify BUSINESS CALLS. The two may share a token or not.
 *
 * The SDK is Resource-Server-side only: a complete Authorization Server
 * (DCR / authorize / token / consent) is not included — point
 * `discovery.authorizationServerMetadata` at your real IdP, or put one in
 * front (network ACL, gateway OAuth).
 */
import {
  OAuthError,
  OAuthErrorCode,
  requireBearerAuth,
  type AuthInfo,
  type AuthMetadataOptions,
  type OAuthMetadata,
  type OAuthTokenVerifier,
} from '@modelcontextprotocol/server'
import { HonoGqlMcpConfigError } from './errors.ts'

export interface AuthDiscoveryOptions {
  /**
   * The public URL of this MCP server — the `resource` value of the Protected
   * Resource Metadata document. Path-aware per RFC 9728: mounting at
   * `/mcp-secure` serves the document at
   * `/.well-known/oauth-protected-resource/mcp-secure`.
   */
  resourceServerUrl: string | URL
  /** RFC 8414 Authorization Server metadata, copied from your IdP — served verbatim at `/.well-known/oauth-authorization-server`. */
  authorizationServerMetadata: OAuthMetadata
  /** Scopes this server understands, advertised as `scopes_supported`. */
  scopesSupported?: string[]
  /** Human-readable name advertised as `resource_name`. */
  resourceName?: string
}

export interface AuthOptions {
  /**
   * Sugar: verify a token yourself. Return the AuthInfo (populate `expiresAt`
   * — epoch seconds — or the gate rejects the token), return null to refuse
   * with 401 invalid_token, or throw an `OAuthError` for precise control.
   */
  verifyToken?: (token: string) => Promise<AuthInfo | null> | AuthInfo | null
  /** SDK escape hatch: a full `OAuthTokenVerifier` (throws `OAuthError` to refuse). Exactly one of verifier / verifyToken / sharedSecret. */
  verifier?: OAuthTokenVerifier
  /**
   * Convenience: one shared token guards the endpoint, no OAuth machinery.
   * A string, or `{ secret, scopes? }`. The minted AuthInfo carries
   * `scopes` (default: `requiredScopes`) and a rolling 1h `expiresAt`.
   * Note: per-tool `toolScopes` beyond the endpoint scopes need real tokens
   * (verifyToken / verifier) to be meaningful.
   */
  sharedSecret?: string | { secret: string; scopes?: string[] }
  /** Endpoint-level scopes every request must carry (403 insufficient_scope when missing). */
  requiredScopes?: string[]
  /**
   * Per-tool scope overrides, checked before the tool runs (HTTP 403
   * pre-dispatch): e.g. `{ graphql_mutation: ['notes:write'] }` demands a
   * higher privilege for writes.
   */
  toolScopes?: Record<string, string[]>
  /** Advertised in 401/403 challenges (RFC 9728) so clients can discover the authorization server. */
  resourceMetadataUrl?: string
  /** RFC 8707 audience check: only accept tokens issued for this resource. */
  expectedResource?: URL
  /** Optionally mount the two well-known discovery routes on the host app. */
  discovery?: AuthDiscoveryOptions
}

/** The gate's verdict — an explicit union, immune to `instanceof` realm issues (see resolveAuth). */
export type GateVerdict = { ok: true; authInfo: AuthInfo } | { ok: false; challenge: Response }

export interface ResolvedAuth {
  /** The SDK gate, wrapped: ok + AuthInfo on success, ok:false + ready-to-return challenge on refusal. */
  gate: (request: Request) => Promise<GateVerdict>
  discovery?: AuthMetadataOptions
  toolScopes?: Record<string, string[]>
}

/** Resolve user options into the SDK gate (throws HonoGqlMcpConfigError on bad combinations). */
export function resolveAuth(opts: AuthOptions): ResolvedAuth {
  const sources = [
    ['verifier', opts.verifier],
    ['verifyToken', opts.verifyToken],
    ['sharedSecret', opts.sharedSecret],
  ].filter(([, v]) => v !== undefined)
  if (sources.length === 0) {
    throw new HonoGqlMcpConfigError('auth needs exactly one of verifier / verifyToken / sharedSecret')
  }
  if (sources.length > 1) {
    throw new HonoGqlMcpConfigError(
      `auth accepts only one verifier source, got: ${sources.map(([n]) => n).join(', ')}`,
    )
  }

  const requiredScopes = opts.requiredScopes ?? []
  let verifier: OAuthTokenVerifier
  if (opts.verifier) {
    verifier = opts.verifier
  } else if (opts.verifyToken) {
    const fn = opts.verifyToken
    verifier = {
      // null → invalid_token; a thrown OAuthError passes through untouched.
      async verifyAccessToken(token) {
        const info = await fn(token)
        if (!info) throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token')
        return info
      },
    }
  } else {
    const shared = typeof opts.sharedSecret === 'string' ? { secret: opts.sharedSecret } : opts.sharedSecret!
    const scopes = shared.scopes ?? requiredScopes
    verifier = {
      async verifyAccessToken(token) {
        if (token !== shared.secret) throw new OAuthError(OAuthErrorCode.InvalidToken, 'invalid token')
        // Rolling expiry: the minted AuthInfo lives for the gate check only.
        return { token, clientId: 'shared-secret', scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600 }
      },
    }
  }

  const rawGate = requireBearerAuth({
    verifier,
    requiredScopes,
    ...(opts.resourceMetadataUrl ? { resourceMetadataUrl: opts.resourceMetadataUrl } : {}),
    ...(opts.expectedResource ? { expectedResource: opts.expectedResource } : {}),
  })
  /**
   * `instanceof Response` is UNRELIABLE across this boundary: some hosts
   * (notably @hono/node-server, used by run()) replace globalThis.Response
   * after this module evaluated, and the SDK's challenge objects then fail
   * the check — the challenge would be mistaken for an AuthInfo and the
   * request let through. Discriminate by shape instead: a challenge carries
   * status + headers, an AuthInfo carries neither.
   */
  const gate = async (request: Request): Promise<GateVerdict> => {
    const result = await rawGate(request)
    if (
      result !== null &&
      typeof result === 'object' &&
      'status' in result &&
      typeof (result as Response).headers?.get === 'function'
    ) {
      return { ok: false, challenge: result as Response }
    }
    return { ok: true, authInfo: result as AuthInfo }
  }

  const discovery: AuthMetadataOptions | undefined = opts.discovery
    ? {
        oauthMetadata: opts.discovery.authorizationServerMetadata,
        resourceServerUrl: new URL(String(opts.discovery.resourceServerUrl)),
        ...(opts.discovery.scopesSupported ? { scopesSupported: opts.discovery.scopesSupported } : {}),
        ...(opts.discovery.resourceName ? { resourceName: opts.discovery.resourceName } : {}),
      }
    : undefined

  return {
    gate,
    ...(discovery ? { discovery } : {}),
    ...(opts.toolScopes ? { toolScopes: opts.toolScopes } : {}),
  }
}
