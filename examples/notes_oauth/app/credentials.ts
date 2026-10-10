/**
 * Credential carriers — how a caller proves identity, resolved in one place
 * (the port of app/credentials.py).
 *
 * The app accepts interchangeable carriers for the same signed identity: the
 * browser's session cookie, and a session-string Bearer (POST /auth/token).
 * Route handlers only call `resolveUser`; they stay ignorant of carriers and
 * of any transport (MCP or otherwise).
 *
 * Python additionally registers the MCP OAuth proxy's token verifier here;
 * the TS demo gates /mcp with the SAME session-string verifier instead (the
 * TS SDK is Resource-Server-side only — see the example README), so this one
 * verifier covers both the business routes and the MCP endpoint.
 */
import { decodeSession, SESSION_COOKIE } from './session.ts'

export type SessionUser = { login: string; name?: string | null; avatar_url?: string | null }

/** token → user payload, or null when this verifier doesn't recognize the token. */
type BearerVerifier = (token: string) => SessionUser | null

const bearerVerifiers: BearerVerifier[] = []

/** Register a Bearer verifier (idempotent per function). */
export function registerBearerVerifier(verifier: BearerVerifier): void {
  if (!bearerVerifiers.includes(verifier)) bearerVerifiers.push(verifier)
}

/** The app's own signed session string (what POST /auth/token hands out). */
export const sessionStringVerifier = (token: string): SessionUser | null => decodeSession(token)

/** The caller's identity from whichever carrier it presented, or null. */
export function resolveUser(request: Request): SessionUser | null {
  const header = request.headers.get('authorization') ?? ''
  const [scheme, param] = header.split(' ', 2)
  if (scheme.toLowerCase() === 'bearer' && param) {
    for (const verify of bearerVerifiers) {
      const user = verify(param)
      if (user !== null) return user
    }
    return null
  }
  const cookie = request.headers
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
  return decodeSession(cookie?.slice(SESSION_COOKIE.length + 1))
}
