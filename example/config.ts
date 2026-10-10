/**
 * Example configuration — the ONE module in example/ that reads process.env.
 *
 * Loaded by the npm script via `node --env-file-if-exists=example/.env`
 * (Node >= 20.12). With GitHub creds empty the app still runs: REST/GraphQL
 * stay open and /mcp is ungated — the mirror of fastapi-gql-mcp's
 * examples/notes_oauth behavior when its .env is blank.
 */

/** Dev-only secret so a blank .env stays bootable. app.ts warns when it is in use. */
const DEV_SECRET = 'dev-secret-do-not-use-in-prod'

export const PORT = Number(process.env.PORT ?? 8020)

/** Public base URL — the OAuth identity of this server (issuer + redirect base). */
export const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`

export const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID ?? ''
export const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET ?? ''

/** Signs better-auth sessions and tokens. */
export const BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? DEV_SECRET

/** True while the shipped dev secret is still in use — app.ts warns at startup. */
export const secretIsDefault = BETTER_AUTH_SECRET === DEV_SECRET

/** RFC 8707 / 9728 resource identifier: the canonical URL of the MCP endpoint. */
export const MCP_RESOURCE = `${BASE_URL}/mcp`

/** GitHub login + MCP OAuth are wired only when BOTH creds are present. */
export const githubConfigured = Boolean(GITHUB_CLIENT_ID && GITHUB_CLIENT_SECRET)

/**
 * Optional egress proxy for the OAuth server's OUTBOUND fetches (CIMD client
 * metadata, GitHub token exchange). Node's fetch ignores http_proxy /
 * https_proxy, and networks that bot-check or throttle those hosts need the
 * proxy named explicitly. Empty = direct connection.
 */
export const OUTBOUND_PROXY = process.env.OUTBOUND_PROXY ?? ''

/**
 * Override the SQLite file location. Empty = `example/data.sqlite` beside the
 * code (store.ts resolves the default relative to the module, not the cwd).
 */
export const SQLITE_PATH = process.env.SQLITE_PATH ?? ''

/**
 * Route-level tracing switch (@hono/otel). Read lazily — createApp({ otel })
 * overrides it — so a test can toggle tracing without mutating process.env.
 */
export const otelEnabled = (): boolean => process.env.HONO_GQL_MCP_OTEL === '1'
