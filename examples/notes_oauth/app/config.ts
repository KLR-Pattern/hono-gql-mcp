/**
 * Environment-driven configuration (.env, see .env.example) — the TS port of
 * app/config.py. Loaded from examples/notes_oauth/.env when present (same
 * keys as the Python demo, so one .env serves both sides).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** dotenv-lite: KEY=VALUE lines, no override of already-set env, missing file is fine. */
function loadEnvFile(path: string): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m || process.env[m[1]] !== undefined) continue
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}
loadEnvFile(join(dirname(fileURLToPath(import.meta.url)), '..', '.env'))

export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? ''
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? ''
export const SESSION_SECRET = process.env.SESSION_SECRET ?? 'dev-secret-do-not-use-in-prod'

export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8020'
export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize'
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token'
export const GITHUB_USER_URL = 'https://api.github.com/user'

export const oauthConfigured = (): boolean => GITHUB_CLIENT_ID !== '' && GITHUB_CLIENT_SECRET !== ''
