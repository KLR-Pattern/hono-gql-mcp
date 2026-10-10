/**
 * Tiny HMAC-signed session cookie — the port of app/session.py, byte-format
 * compatible: `base64url(json_payload).hex_hmac` (HMAC-SHA256 over the raw
 * JSON, hex digest). A token minted by the Python demo verifies here and
 * vice versa — same SESSION_SECRET, same wire format.
 *
 * Not a hardened auth library; just enough for the demo while keeping the
 * flow real (cookie in → protected route out).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { SESSION_SECRET } from './config.ts'

export const SESSION_COOKIE = 'demo_session'
const TTL_SECONDS = 24 * 3600

const sign = (data: string): string =>
  createHmac('sha256', SESSION_SECRET).update(data).digest('hex')

export interface SessionPayload {
  login: string
  name?: string | null
  avatar_url?: string | null
  exp: number
}

export function encodeSession(
  payload: Omit<SessionPayload, 'exp'>,
  ttl = TTL_SECONDS,
): string {
  const body: SessionPayload = { ...payload, exp: Math.floor(Date.now() / 1000) + ttl }
  const raw = JSON.stringify(body)
  return `${Buffer.from(raw).toString('base64url')}.${sign(raw)}`
}

export function decodeSession(cookie: string | undefined | null): SessionPayload | null {
  if (!cookie || !cookie.includes('.')) return null
  const dot = cookie.lastIndexOf('.')
  const encoded = cookie.slice(0, dot)
  const signature = cookie.slice(dot + 1)
  let raw: string
  try {
    raw = Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const expected = sign(raw)
  if (
    expected.length !== signature.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
  ) {
    return null
  }
  let payload: SessionPayload
  try {
    payload = JSON.parse(raw) as SessionPayload
  } catch {
    return null
  }
  if (typeof payload !== 'object' || (payload.exp ?? 0) < Date.now() / 1000) return null
  return payload
}
