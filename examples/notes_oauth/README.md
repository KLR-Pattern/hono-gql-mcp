# Example: notes-oauth — GitHub OAuth + Notes (TS port)

The TypeScript counterpart of
[fastapi-gql-mcp's notes_oauth](../../../fastapi-gql-mcp/examples/notes_oauth):
a Notes API behind **GitHub OAuth**, exposed to agents via **GraphQL + MCP**.
You log in with GitHub, and the same identity lets you — or an agent acting
as you — query, create and delete notes. **Same port (8020), same `.env`
keys, same session-token wire format** — swap the two servers behind one
GitHub OAuth App and behavior should match (see Deltas).

## Setup

### 1. The GitHub OAuth App

Reuse the app you registered for the Python demo — same values:

| Field | Value |
|---|---|
| Homepage URL | `http://localhost:8020` |
| Authorization callback URL | `http://localhost:8020/auth/callback` |

### 2. Configure and run

From the repo root:

```bash
cd examples/notes_oauth
cp .env.example .env        # fill GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET + SESSION_SECRET
cd ../..
npm run example:oauth       # serves http://localhost:8020
npm run smoke:oauth         # headless full-flow check (no GitHub needed)
```

| `.env` key | What it is |
|---|---|
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | from the OAuth App above |
| `SESSION_SECRET` | signs the session cookie and Bearer tokens — **use the same value as the Python demo's `.env`** and tokens minted by either side verify on both |
| `BASE_URL` | default `http://localhost:8020` |

The note store is in-memory — data resets on every restart. Empty GitHub
creds still run the app (REST/GraphQL work; the MCP endpoint is open instead
of gated).

### 3. Validate the full flow

1. **Login** — open http://localhost:8020/auth/ → *Login with GitHub* →
   back to `/auth/me` showing your GitHub identity.
2. **REST** — `curl http://localhost:8020/api/notes` with the session
   cookie (or browse `/openapi.json`).
3. **GraphiQL** — http://localhost:8020/graphiql, run
   `{ notes { mine { list_notes { title } } } }` (your cookie rides along).
4. **MCP** — `curl -X POST http://localhost:8020/auth/token` (with the
   cookie) to mint a Bearer, then point an MCP client at
   `http://localhost:8020/mcp` with `Authorization: Bearer <token>`.

## Architecture (mirrors the Python demo)

| Python (`app/`) | TS (`app/`) | What it does |
|---|---|---|
| `config.py` | `config.ts` | env-driven config, `.env` loaded by hand (no dotenv dep) |
| `session.py` | `session.ts` | `base64url(json).hex_hmac` signed session — byte-compatible |
| `credentials.py` | `credentials.ts` | carrier resolution: cookie / session-string Bearer |
| `auth_routes.py` | `auth-routes.ts` | `/auth/login`, `/auth/callback`, `/auth/me`, `/auth/token`, `/auth/logout`, home |
| `notes_routes.py` | `notes-routes.ts` | `/api/notes…`, `/api/stats`, deprecated `/api/legacy/stats`, multipart attach (bridge-skip demo), dynamic `/api/overview` (JSON-bucket demo) |
| `store.py` | `store.ts` | in-memory notes, two seed rows |
| `main.py` | `main.ts` | `HonoGqlMcp(app, { allowMutation: true, exclude: ['/auth/token'], passthroughHeaders: ['authorization', 'cookie'], auth })`, mountTo `/mcp`, mountGraphQL |
| `__main__.py` | `main.ts` (run-direct block) | banner + serve on 127.0.0.1:8020 |
| `scripts/smoke.py` | `scripts/smoke.ts` | headless full flow ①-⑤ |

## Deltas vs the Python demo

- **MCP-client login**: Python gates `/mcp` with fastmcp's GitHub OAuth
  proxy (interactive browser login, OAuth 2.1 discovery, reference JWTs).
  The `@modelcontextprotocol` TS SDK is Resource-Server-side only, so this
  demo verifies **the same signed session string** at the gate
  (`auth.verifyToken`) — MCP clients authenticate with the Bearer minted by
  `POST /auth/token`. One token, two checks: the gate checks the endpoint,
  the routes' own `requireUser` checks the business call.
- **`/api/notes/{id}/summary`**: Python degrades it to the raw-JSON scalar
  via `response_model_exclude_unset`; the zod mapper types optional fields
  natively, so the field stays field-selectable here.
- **Derived field names** of the redirect routes differ (`get_auth_login`
  vs `login`) — both land in the raw-JSON bucket and are not meant to be
  called through GraphQL.
- No `/docs` Swagger UI (serves `/openapi.json` instead); no optional OTLP
  export in the example.
