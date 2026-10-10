# hono-gql-mcp

The **agent access layer for Hono** — agents call one `graphql_query` tool
with full composition and per-caller credentials, instead of one tool per
route. The GraphQL layer and MCP server are derived from your existing
`@hono/zod-openapi` app: zero decorators, zero schema changes.

TypeScript port of [fastapi-gql-mcp](../fastapi-gql-mcp)'s architecture
(Apollo's "GraphQL as the MCP contract" pattern, applied to REST-first
services — the position no TS project occupied as of 2026-10).

```ts
import { OpenAPIHono } from '@hono/zod-openapi'
import { HonoGqlMcp } from 'hono-gql-mcp'

const app = new OpenAPIHono()
// ... your existing createRoute() routes + app.openapi(route, handler) ...

const mcp = new HonoGqlMcp(app, { name: 'my-app' })
mcp.mountTo(app, '/mcp')      // MCP at /mcp, auth rides the caller's headers
mcp.mountGraphQL(app)         // optional: POST /graphql + GraphiQL
```

## How it works

Three steps, each the direct counterpart of the Python original:

1. **Scan** — `app.openAPIRegistry.definitions` holds the original
   `createRoute()` configs (Zod schemas, tags, summaries, descriptions).
   This is the same public registry `getOpenAPIDocument()` walks. `hide: true`
   routes never enter it (same semantics as `include_in_schema=False`).
2. **Build** — a `graphql-js` schema is assembled: tags become domain groups
   (`tags: ['shop:catalog']` answers at `{ shop { catalog { … } } }`, a
   multi-tag route lands in every one of its domains), `operationId` becomes
   the field name, Zod schemas become GraphQL types (`.meta({ title })` names
   a type, `.describe()`/`summary` become descriptions).
3. **Execute** — each field's resolver calls its route in-process through
   `app.request()` (the same `#dispatch` production `fetch` uses), so
   middleware, auth and validation behave exactly as over HTTP. Sibling
   fields resolve concurrently.

### Architecture map to fastapi-gql-mcp

| fastapi-gql-mcp (Python) | hono-gql-mcp (TS) |
|---|---|
| `app.routes` + Pydantic annotations | `openAPIRegistry.definitions` + Zod schemas |
| Pydantic → GraphQL mapper (graphql-core) | `ZodGraphqlMapper` reading Zod v4 `.def` (graphql-js) |
| `tags=["shop:catalog"]` → domain tree | `RouteConfig.tags` → same tree (`domains.ts`, multi-tag membership) |
| docstrings → schema descriptions | `summary` / `description` / `.describe()` / `.meta()` |
| in-process ASGI call | `app.request()` (same `#dispatch` as production) |
| `passthrough_headers=["authorization"]` | same default, case-insensitive whitelist |
| fastmcp | `@modelcontextprotocol/server` 2.x `createMcpHandler` + `McpServer` |

### The Zod mapper

The one piece with no existing wheel (verified 2026-10: GQLoom is the only
directionally-similar project, 0.x and stale on npm). Mapping rules:

- `z.string()` → `String`, `z.number()` → `Int`/`Float` (int detection reads
  both `z.int()`'s top-level check and `z.number().int()`'s `checks`),
  `z.boolean()` → `Boolean`, `z.date()` → custom `Date` scalar (ISO wire format)
- `z.object` → `GraphQLObjectType` (output) / `GraphQLInputObjectType` (input)
- `z.enum` → `GraphQLEnumType`; member names must be legal GraphQL identifiers
- `z.array` → `List` with `NonNull` elements; `z.lazy` → recursion via the
  fields thunk
- `z.pipe` → input side maps from `.in`, output side from `.out`
- `z.coerce` query params map by their OUTPUT type (GraphQL sends a JSON
  number; it is stringified into the query string, the route's coerce parses it)

## Capability buckets

Same promise as the Python bridge: **if a route works over HTTP, it stays
callable here.** Every route lands in one of four buckets, classified at scan
time (thunks are forced at construction — the audit and any
DuplicateFieldError are startup facts, not first-query surprises):

| Bucket | Trigger | Result |
|---|---|---|
| Structured | typed 2xx JSON response schema | field-selectable type |
| Boolean success | `z.void()` response, or a 2xx with no content (204-style) | `true` on 2xx, errors surface as field errors |
| Raw JSON | 2xx without a JSON schema, `z.record`/`z.union`/`z.literal`/`z.any` shapes | `JSON` scalar — still callable, no per-field selection; startup notice names the cause |
| Skipped | non-JSON body, param/query/body argument name collision, write verb with `allowMutation=false`, write route outside `mutationInclude` | `handler.readiness().skips` records `{ method, path, reason }` |

Leaf fields are always nullable: a failing route nulls only its own field (a
NonNull leaf would propagate the error to its whole domain group).

## Progressive disclosure (large apps)

Above `progressiveThreshold` routes (default 25, counted after filtering),
`mode: 'auto'` switches the toolset to a 4-layer walkthrough of the tag tree:

```
list_domains ──▶ list_queries("billing:invoice") ──▶ get_query_schema("billing:invoice") ──▶ graphql_query
                     (list_mutations with allowMutation: true)
```

`get_schema` is NOT registered in progressive mode — discovery goes through
domain fragments instead. Each fragment re-wraps the schema's real group
types along the path with sibling-free wrappers, so it shows **exactly the
grouped query the agent must write**, with every reachable type collected and
nothing else. **Discovery is scoped; execution is not**: `graphql_query`
always runs against the full schema, so fields from different domains combine
freely. Force either mode with `mode: 'simple' | 'progressive'`.

## Route filters & multiple deployments

fnmatch globs (`*` crosses `/`), with the Python bridge's semantics — drops
are silent (filtering you asked for, not skips):

- `include` / `exclude` — over route paths, exclude wins
- `includeTags` / `excludeTags` — a route matches when ANY string tag matches
  ANY pattern; `includeTags` is a strict whitelist (untagged routes drop),
  `excludeTags` wins; tag filters AND with path filters
- `excludeDeprecated` — drops `deprecated: true` routes; routes that stay
  keep their GraphQL-native `@deprecated` mark
- `mutationInclude` — with `allowMutation: true`, whitelists WHICH write
  routes become mutations

Different MCP consumers often need different slices: build one `HonoGqlMcp`
per use case, each scoped by its own filters, each mounted at its own path.

## The plain-GraphQL face

`bridge.mountGraphQL(app)` serves `POST /graphql`
(`{query, variables?, operationName?}`) and the GraphiQL playground at
`/graphiql`. `GET /graphql` answers 405 with usage. The face shares the
handler's passthrough whitelist with MCP — browser sessions ride `cookie`
once it is whitelisted. Status parity with the Python face: 200 while `data`
is present (partial failure keeps nulls + errors), 400 for whole-document
failure.

## Options

```ts
new HonoGqlMcp(app, {
  name: 'my-app',
  version: '0.1.0',
  allowMutation: false,               // write routes off by default
  passthroughHeaders: ['authorization'],  // caller → route header whitelist ([] disables)
  instructions: '…',                  // initialize handshake text; a useful default is derived
  // discovery
  mode: 'auto',                       // 'simple' | 'progressive' | 'auto' (default)
  progressiveThreshold: 25,
  // filters (see above)
  include: undefined, exclude: undefined, includeTags: undefined, excludeTags: undefined,
  excludeDeprecated: false, mutationInclude: undefined,
  // hardening (see below)
  requestTimeoutMs: 30_000,
  maxConcurrency: 16,
  maxDepth: 10,
  documentCacheSize: 128,
  maxResponseChars: 1_000_000,        // tool result truncation bound
  rateLimit: { maxPerSecond: 10 },    // optional, per-process, keyed by hashed authorization
})
```

Invalid configuration throws `HonoGqlMcpConfigError` before anything is
derived. `bridge.handler` exposes the plain face:
`getSDL()`, `execute(query, variables, { headers, operationName })`,
`readiness()`, `skips`, `registry`, `queryFields`/`mutationFields`,
`routes`, `resolvedMode`.

## Hardening

Four knobs, on by default with the same semantics as the Python bridge:

- **`requestTimeoutMs`** (default 30s, `null` disables) — per-route-call
  deadline. The in-process `app.request()` call has no HTTP client timeout to
  lean on, so enforcement lives in a race (plus a best-effort `AbortSignal`
  downstream). A timed-out field surfaces as a `TIMEOUT` error while its
  siblings survive. Queue waits count against the deadline.
- **`maxDepth`** (default 10, `null` disables) — maximum selection-set nesting
  per document, fragments resolved and cycle-guarded. Recursive types make
  depth unbounded and an MCP caller is an LLM that can emit runaway nesting;
  over-deep documents are rejected with a validation-style error **before
  anything executes**.
- **`maxConcurrency`** (default 16, `null` disables) — bound on in-flight
  route calls across all queries (FIFO semaphore). Sibling fields resolve
  concurrently; this protects the wrapped app from being hammered by its own
  bridge.
- **`documentCacheSize`** (default 128, 0 disables) — LRU capacity for the
  parse + depth-guard + validate front half of execution, keyed by the query
  string. Agents repeat documents constantly. **Execution results are never
  cached** — per-call credentials run for real every time (verified by a test
  that mutates state between two identical documents).

Plus two MCP-face guards: `maxResponseChars` (default 1M) truncates oversized
tool results with a marker, and the optional `rateLimit` is a per-process
fixed-window limiter keyed by a hash of the caller's authorization header
(credentials are never stored) — `keyBy` customizes the key.

`readiness()` returns the CI-assertable audit — `{ ready, skips, degraded,
degradedFields }` — the same classifier the startup notices come from, so the
report and the warnings can never drift apart. `assert report.ready` in CI
pins the exposure you expect.

## Verified (PoC, 2026-10-10)

`npm test` — 36 end-to-end checks, all passing:

- composition across 3 domains (nested tag included); field selection;
  partial failure (a 404 route nulls only itself, siblings survive)
- per-caller auth at both faces: no credentials → `HTTP_401` field errors
- recursion via `z.lazy` serves true depth; 204-style delete → `true`
- degradation audit (`by_tag: JSON` + startup notice); mutation gating
- **full MCP round trip in-process** (real client SDK over streamable HTTP via
  custom fetch → `app.request`): constant tool catalog with
  `readOnlyHint`/`destructiveHint` annotations, `get_schema`, composed
  `graphql_query`, `graphql_mutation` write-then-read, `graphql_query`
  refusing mutation documents (with the write confirmed not executed)
- hardening: slow field → `TIMEOUT` with surviving sibling; in-flight route
  calls bounded by `maxConcurrency` (measured from the route side); queue
  waits count against the deadline; `max_depth` rejects runaway nesting
  before execution; LRU recency/eviction; document cache proves execution
  stays live across identical documents
- filters: tag whitelist drops untagged routes, `excludeTags` wins, path
  globs, `excludeDeprecated` + `@deprecated` travel, `mutationInclude`
  whitelists writes; multi-tag routes land in both domain groups
- progressive: `auto` flips above the threshold; 4-tool catalog (no
  `get_schema`); the full `list_domains → list_queries → get_query_schema →
  graphql_query` walkthrough incl. unknown-domain `DOMAIN_NOT_FOUND`
  envelope and cross-domain execution; nested-domain fragments re-wrap the
  real group types, siblings excluded
- readiness audit; DuplicateFieldError at construction; config errors
- `/graphql` face (POST with credentials, 405 usage, partial-failure 200) and
  GraphiQL; `maxResponseChars` truncation marker; `rateLimit` 429; `run()`
  standalone server on a real port
- plus a real-socket smoke test: REST 401/200, MCP initialize → tools/list →
  tools/call with and without credentials, `/graphql` + `/graphiql`

Stack: hono 4.13 · @hono/zod-openapi 1.6 (Zod v4 only) · graphql-js 17 ·
@modelcontextprotocol/server 2.3 · Node ≥ 22 (graphql-js 17's floor).

## Not in the PoC (the Python original has them)

- OAuth on the MCP endpoint (a token-gate + OAuth 2.1 providers)
- OpenTelemetry spans (`graphql.execute` + W3C traceparent injection)
- zValidator-style routes (schema is closure-private — needs a thin
  Symbol-attachment wrapper, ~50 lines, rhinobase/hono-openapi precedent)
- sub-app mounting (`app.route()` + `basePath()`): registry path merging was
  verified in isolation during research; not covered by this test suite
- benchmark comparison against fastmcp-TS `fromOpenAPI` / ClawQL (the Python
  repo's comparison/ methodology ports directly)

## Dev

```bash
npm install
npm test          # 36 e2e checks
npm run example   # notes demo on :8100 — REST + /mcp + /graphql + /graphiql
npm run typecheck
```
