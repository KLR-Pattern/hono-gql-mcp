# hono-gql-mcp

The **agent access layer for Hono** — agents call one `graphql_query` tool
with full composition and per-caller credentials, instead of one tool per
route. The GraphQL layer and MCP server are derived from your existing
`@hono/zod-openapi` app: zero decorators, zero schema changes.

TypeScript port of [fastapi-gql-mcp](../fastapi-gql-mcp)'s architecture
(Apollo's "GraphQL as the MCP contract" pattern, applied to REST-first
services — the position no TS project occupied as of 2026-10).

> **Status:** published as [`hono-gql-mcp`](https://www.npmjs.com/package/hono-gql-mcp)
> `0.1.1`. Still a PoC — see [Package status](#package-status) for what the
> build does and does not cover yet.

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

### Mutation ordering

Reads run concurrently. Writes run **serially, in document order** — one
mutation per `execute()` call, so two in-flight documents never serialize
against each other.

This needs the explicit `SerialQueue` in `executor.ts` because the tag grouping
hides the write fields from graphql-js's own serializer. The spec serializes
*root* mutation fields, but a tagged write lands at
`mutation { notes { create_note } }` — the root holds the single group field
`notes`, and the writes beneath it are ordinary object fields, which graphql-js
resolves concurrently. Resolvers reach the queue in document order, and a FIFO
chain restores the guarantee. A failing write does not block its successors.

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

### zValidator-style routes

Routes written with plain `@hono/zod-validator` cannot be derived — the
schema lives in the validator's closure and nothing exposes it at runtime.
`bridgeValidator` is a drop-in wrapper (zValidator behavior unchanged) that
attaches the schema to the middleware under a well-known Symbol, which the
scanner reads as a second introspection source — one import line is the
whole migration:

```ts
import { bridgeValidator } from 'hono-gql-mcp'

app.get(
  '/search',
  bridgeValidator('query', SearchQuery, {
    tags: ['notes'],                      // domain grouping
    summary: 'Search notes by title.',
    responseSchema: z.array(Note),        // without it → the raw-JSON bucket
  }),
  (c) => c.json(hits),                    // c.req.valid() types flow as with zValidator
)
```

Semantics vs zod-openapi routes: `param`/`query`/`json` targets map to
params/query/body arguments; `form` targets and wildcard paths are dropped
(silently — no RouteConfig exists to classify into skip buckets); tags and
path filters apply the same way; the field name derives as
`<method>_<path>` when no operationId concept applies. zod-openapi routes
(registered via `app.openapi`) never duplicate — their handlers carry no
Symbol.

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
- `z.array` query args travel as **repeated keys** (`?tags=a&tags=b`), which is
  what Hono's query parser collects back into an array. `URLSearchParams.set()`
  would send `?tags=a,b` and the route's own `z.array()` check would answer 400

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
| Skipped | non-JSON body, required header/cookie parameter (it cannot be a GraphQL argument — caller credentials ride `passthroughHeaders`), param/query/body argument name collision, write verb with `allowMutation=false`, write route outside `mutationInclude` | `handler.readiness().skips` records `{ method, path, reason }` |

Leaf fields are always nullable: a failing route nulls only its own field (a
NonNull leaf would propagate the error to its whole domain group).

Two states need a word, because both are reachable through ordinary
configuration rather than misuse:

- **No read route survived the scan.** `type Query` then has no fields, and
  graphql-js treats the whole schema as invalid — every document, valid or not,
  would make it throw. A write-only app, or filters that kept nothing, gets
  here. Construction still succeeds (your own filters may have done this on
  purpose); `handler.hasQueryOperations` reports it, a startup warning names it,
  and `graphql_query` refuses documents with a `NO_QUERY_OPERATIONS` error.
- **Two schemas share a `.meta({ title })`.** GraphQL has one global type
  namespace, so the second is renamed (`Item` → `Item_2`). That costs no
  capability, so it is reported as `readiness().renames` and **does not** affect
  `ready` — an `assert report.ready` CI gate has to stay meaningful.

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
failure. The POST must carry `Content-Type: application/json` (415 otherwise)
— Hono's body parser accepts any content-type, and a `text/plain` HTML-form
POST is a CORS "simple request" that skips preflight, so the check is what
keeps a cross-site page from firing mutations with a whitelisted session
cookie.

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
  hostValidation: {                   // REQUIRED when deployed on a real hostname —
    allowedHostnames: ['api.example.com'],  // the default (localhost-only) 403s every
    allowedOrigins: ['claude.ai'],          // other Host/Origin; [] disables either half
  },
  auth: { … },                        // gate the MCP endpoint — see Authentication
})
```

Invalid configuration throws `HonoGqlMcpConfigError` before anything is
derived — including the hardening knobs (`maxConcurrency: 0` would deadlock
every call behind a never-granted permit; `requestTimeoutMs: 0` would abort
every call instantly). Two routes sharing an operationId in one domain throw
`DuplicateFieldError` at construction. `bridge.handler` exposes the plain face:
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
  anything executes**. Fragments do not count: a spread and an inline fragment
  contribute fields to the selection set they appear in, so they add no depth
  (`__`-prefixed introspection meta-fields are exempt for the same reason).
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

**`hostValidation` — read this before deploying past localhost.** The MCP
endpoint validates the `Host` and `Origin` headers (DNS-rebinding and
cross-site protection, on the SDK's validators), and the default allowlist is
`localhost / 127.0.0.1 / [::1]` only. On a real hostname **every request is
answered 403** — CLI MCP clients send `Host`, browsers send both — until you
name the host:

```ts
new HonoGqlMcp(app, {
  hostValidation: {
    allowedHostnames: ['api.example.com'], // port-agnostic hostnames; IPv6 needs brackets
    allowedOrigins: ['claude.ai'],         // browser clients; non-browser clients send no Origin and always pass
  },
})
```

Each half defaults independently to the localhost allowlist; pass `[]` to
disable one (e.g. behind a TLS-terminating proxy that rewrites Host).

`readiness()` returns the CI-assertable audit — `{ ready, skips, degraded,
degradedFields, renames }` — the same classifier the startup notices come from,
so the report and the warnings can never drift apart. `assert report.ready` in
CI pins the exposure you expect.

Only `skips` and `degradedFields` count toward `ready`, because only they cost
you a capability. `renames` is a separate list: a type name that had to be
disambiguated. Keeping the two apart is what makes the CI gate usable — a
harmless name collision must not fail an audit you would then switch off.

## Authentication

The MCP endpoint gate, on SDK (`@modelcontextprotocol/server` 2.x) Protected
Resource primitives. Enforcement order: rate limit → host/origin validation
→ **auth gate** → handler.

```ts
const mcp = new HonoGqlMcp(app, {
  name: 'my-app',
  allowMutation: true,
  auth: {
    // exactly one verifier source (three styles, see below)
    sharedSecret: 'one-shared-token',
    // verifyToken: (token) => (token === ok ? { token, clientId, scopes, expiresAt } : null),
    // verifier: myOAuthTokenVerifier,          // SDK escape hatch
    requiredScopes: ['mcp'],                    // endpoint-level (403 insufficient_scope)
    toolScopes: { graphql_mutation: ['notes:write'] },  // per-tool, pre-dispatch 403
    resourceMetadataUrl: 'https://api.example.com/.well-known/oauth-protected-resource/mcp',
    discovery: {                                // optional: mount the RFC 9728/8414 routes
      resourceServerUrl: 'https://api.example.com/mcp',
      authorizationServerMetadata: idpMetadata, // copied from your IdP, served verbatim
      scopesSupported: ['mcp', 'notes:write'],
    },
  },
})
```

- **Verifier sources** (exactly one; anything else throws
  `HonoGqlMcpConfigError`): `sharedSecret` (one token, no OAuth machinery —
  mints a rolling 1h AuthInfo), `verifyToken` (return the AuthInfo or null →
  401; populate `expiresAt` — epoch seconds — or the gate rejects the token;
  throw `OAuthError` for precise control), or `verifier` (a full SDK
  `OAuthTokenVerifier`).
- **One token, two checks**: the gate verifies the ENDPOINT; the routes' own
  security schemes verify BUSINESS CALLS via per-caller passthrough. The two
  may share a Bearer or not.
- **Scopes**: `requiredScopes` applies at the gate (403 with a
  `WWW-Authenticate: Bearer ... insufficient_scope` challenge);
  `toolScopes` attaches SDK scope challenges to individual tools — enforced
  **before dispatch** (HTTP 403, not an in-band tool error), so writes can
  demand higher privilege than reads.
- **Discovery**: with `auth.discovery`, `/.well-known/oauth-protected-resource[/path]`
  (RFC 9728, path-aware) and `/.well-known/oauth-authorization-server`
  (RFC 8414, your AS metadata verbatim) are mounted on the host app — public
  by design: clients discover BEFORE authenticating. Host routes registered
  earlier win, per Hono's first-match rule.
- **What the SDK gives vs what you bring**: this is the Resource Server side
  only — Bearer verification, RFC 6750 challenges, RFC 9728 discovery,
  RFC 8707 audience checks (`expectedResource`). A complete Authorization
  Server (DCR / authorize / token / consent) is not included: point
  `discovery.authorizationServerMetadata` at your real IdP, or put one in
  front.

One implementation note: the gate's verdict is discriminated **by shape**
(`status` + `headers`), not `instanceof Response` — hosts like
`@hono/node-server` replace `globalThis.Response` at runtime, which would
otherwise make the SDK's challenge objects fail the check and let
unauthenticated requests through (found the hard way; there is a regression
test).

## Observability (OpenTelemetry)

One waterfall per query — install an OTel SDK next to your app and that is
the whole setup (`@opentelemetry/api` is a direct dependency; without a
registered SDK every span here is a no-op):

```
POST /mcp                       (HTTP entry — the host's @hono/otel middleware)
└─ tools/call graphql_query     (tool layer — we emit)
   └─ graphql.execute           (orchestration — we emit; route.timeout / route.queue surface as span events)
      └─ GET /notes             (route layer — @hono/otel extracts the W3C traceparent
                                  we inject into every in-process route call)
```

For route spans, mount `@hono/otel`'s `httpInstrumentationMiddleware`
**before your routes** (Hono middleware registered after a handler does not
wrap it) — the example does this under `HONO_GQL_MCP_OTEL=1`:

```bash
HONO_GQL_MCP_OTEL=1 npm run example   # route spans nest under graphql.execute
```

**Bonus over the Python bridge**: the MCP protocol (2026-07-28) carries the
client's W3C trace context in the envelope `_meta` (`traceparent`). When an
agent client propagates it, the tool span parents to the CALLER's trace —
end to end from the agent client through GraphQL orchestration down to the
business routes.

Two implementation notes (both regression-tested):
- Spans are wired manually (`startSpan` + `context.with` on our own api
  import), not via `tracer.startActiveSpan` — the api package's exports map
  can load two instances depending on the resolver, and the SDK-internal
  `context.with` may land on the one whose context manager is never
  registered, silently breaking nesting.
- The W3C propagator is a pinned own instance — the api's GLOBAL propagator
  stays a no-op until the host registers one, and extraction/injection must
  not depend on that.

## Package status

Publishable. `npm run build` emits `dist/` and `exports`/`files` point at it, so
a consumer installs the JavaScript and its `.d.ts`, never the sources.

Two details worth knowing before changing build config:

- Sources import each other as `./x.ts` — that is what lets Node's type
  stripping run them directly, with no bundler. `tsconfig.build.json` sets
  `rewriteRelativeImportExtensions`, which turns those into `./x.js` on emit.
  The `.d.ts` files keep the `.ts` specifier, which TypeScript resolves
  correctly, so no post-processing step is needed.
- The build uses `tsc` only. There is no bundler, so nothing in the emit
  depends on how the package is consumed.

### CI

Three workflow files, and the split is deliberate:

| File | Trigger | Does |
| --- | --- | --- |
| `test.yml` | `workflow_call` only | `npm ci` → typecheck → 61 checks → build |
| `ci.yml` | PR and push to `master` | calls `test.yml` |
| `publish.yml` | `v*` tag | calls `test.yml`, then publishes |

`test.yml` holds the steps **once**. Both gates call it instead of repeating
them, so a check added to one cannot go missing from the other — the failure
mode that split definitions produce is green pull requests followed by a failed
release. The build step runs there too, not just at tag time: `tsconfig.build.json`
is separate from the typecheck config, so the emit can break on its own.

`ci.yml` cancels superseded runs on the same branch, since finishing a test for
an already-replaced commit wastes runner time and delays the current one.

### Releasing

Push a tag that matches `package.json`'s version:

```bash
npm version patch        # or minor / major — writes package.json + the tag
git push --follow-tags
```

`publish.yml` then runs the same `test.yml` job, verifies the tag equals the
version, and publishes with `--provenance`.

One ordering rule is easy to trip over: **the workflow file must already be on
the default branch before you push the tag.** Adding `.github/workflows/publish.yml`
and pushing the tag in the same push runs nothing and reports nothing — GitHub
evaluates the tag event against the default branch, where the workflow does not
exist yet. Push the workflow first, then tag. Re-pushing an existing tag
(`git push origin --delete v0.1.1 && git push origin v0.1.1`) is the repair.

Authentication is **OIDC trusted publishing** — no `NPM_TOKEN` secret exists in
the repository. Trusted publishers are configured on the *package's* settings
page, so the package has to exist on the registry first: **the very first
version must be published manually**, and the workflow takes over from the
second one.

Bootstrap order:

| # | Step | Where |
| --- | --- | --- |
| 1 | `npm login` then `npm publish --access public` | local, once |
| 2 | Fill in the Trusted Publisher fields below | npmjs.com → package Settings |
| 3 | `npm version patch && git push --follow-tags` | the workflow publishes |

The Trusted Publisher fields, under the package's **Settings → Trusted
Publisher** (all values are case-sensitive and must match exactly; a mismatch
surfaces as `ENEEDAUTH`):

| Field | Value |
| --- | --- |
| Organization or user | your GitHub account/org |
| Repository | `hono-gql-mcp` |
| Workflow filename | `publish.yml` — filename only, not a path, extension included |
| Environment | *(leave empty)* |
| Allowed actions | must permit **`npm publish`** — only `npm stage publish` is allowed by default |

Getting `Allowed actions` wrong produces a confusing failure: the provenance
statement is signed successfully (so OIDC is clearly working), then the publish
returns **`E404 Not Found - PUT .../hono-gql-mcp`**. npm deliberately answers
404 rather than 403 for an unauthorized write, so the message points at the
package rather than at the permission. If you see a signed provenance line
followed by E404, enable `npm publish` and re-run the job — nothing is wrong
with the package or the workflow.

`package.json` carries a `repository.url` matching the GitHub repo; npm requires
that exact match for OIDC. A fresh trusted-publisher configuration must complete
its first publish **within 2 days** or it expires and must be recreated.

CI builds on **Node 24 (Active LTS)**, read from `.nvmrc` — the single source of
truth for the toolchain version. That matters for publishing: Node 24 ships
**npm 11.19.0**, and OIDC trusted publishing needs **npm ≥ 11.5.0**. Node 22
would ship npm 10.x and force an `npm install -g npm@latest` step on every run.
The verified run (2026-10-11) used Node 24.21.0 / npm 11.19.0.

## Verified (PoC, 2026-10-11)

`npm test` — 18 unit + 72 end-to-end checks, all passing (plain `node`,
type-stripping mode); `npm run test:cov` reports c8 line/branch coverage
over `src/`. The unit layer covers the pure pieces in isolation: fnmatch
globs (incl. `[seq]` character classes), `documentDepth` (fragments, inline
fragments, cycles, introspection exemption), `LruCache`, domain grouping,
the Zod mapper's enum paths (legal and illegal member names, the shared
input/output instance, int detection, union/literal/any → JSON, renames),
option validation for every hardening knob, and the required header/cookie
skip rule. The e2e layer:

- **regression guards for the 2026-10-11 review**: mutations serialize in
  document order despite the domain-group wrapper (reverting the fix fails the
  check); array query args arrive as arrays, not a comma-joined string;
  a schema with an empty `type Query` reports instead of throwing at request
  time; a type-name rename is reported without marking the bridge unready;
  fragments add no depth; and the `graphql_query` description's example is
  derived from the live schema and asserted runnable
- **later additions**: `graphql_mutation` refusing non-mutation documents;
  sub-app mounting (`app.route()` registry path merge) derived and executed;
  multipart-body skip; explicit `z.void()` Boolean success; non-JSON 2xx
  raw-text passthrough; `get_query_schema` on a mutation-only domain answering
  `DOMAIN_NOT_FOUND`

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
- REST docs: `/openapi.json` (OpenAPI 3.1) carries every zod-openapi route,
  with the recursive `Category` schema emitted as a `$ref` (not inlined); the
  Swagger UI at `/docs` is mounted and wired to it; both public while business
  routes stay gated
- auth: the gate's 401 `WWW-Authenticate` challenge (no/bad/null token);
  sharedSecret full MCP round trip; gate-vs-route independence (gate token ≠
  route token → `HTTP_401` field errors); `requiredScopes` 403 with scope
  hint; per-tool scopes — `graphql_mutation` refused pre-dispatch 403 without
  the write scope, runs with it; RFC 9728/8414 discovery routes (public by
  design, normal paths untouched); config errors (verifier sources are
  mutually exclusive); and the `instanceof Response` realm regression
  (`run()` + gate in one process)
- the example end to end: a real better-auth JWT passes the gate AND the
  routes (one token, two checks, `WWW-Authenticate` carries `resource_metadata`);
  per-user isolation (another user's note is absent from the list and a direct
  fetch is 404)
- OTel: the four-layer waterfall (HTTP → tools/call → graphql.execute →
  route span, one traceId) with a real in-memory exporter + AsyncHooks
  context manager; envelope traceparent joining the CALLER's trace;
  route.timeout / route.queue as span events on graphql.execute
- bridgeValidator routes: derived beside zod-openapi routes (no
  DuplicateFieldError), typed args flowing, callable end to end; no
  responseSchema → the raw-JSON bucket with a notice (not a skip); form
  targets and wildcard paths dropped; tag/path filters apply
- `graphql_mutation` refusing non-mutation documents (symmetric with the
  `graphql_query` refusal); `list_mutations` in the progressive walkthrough;
  cookie passthrough (whitelisted header rides, unlisted headers never do)
- plus a real-socket smoke test: REST 401/200, MCP initialize → tools/list →
  tools/call with and without credentials, `/graphql` + `/graphiql`

Stack: hono 4.13 · @hono/zod-openapi 1.6 (Zod v4 only) · graphql-js 17 ·
@modelcontextprotocol/server 2.3 · better-auth 1.7 (OAuth 2.1 AS + JWT) ·
better-sqlite3 (persistence).

Runtime floor: **Node ≥ 22.18**. That is graphql-js 17's floor raised by two
things this package depends on — type stripping to run its own sources, and
`require(esm)`, which the MCP SDK's CJS neighbourhood needs. CI and `.nvmrc`
track **Node 24 LTS**, and the suite passes on both 24.21.0 and 22.22.0.

## Not in the PoC (the Python original has them)

- sub-app mounting (`app.route()` + `basePath()`): registry path merging was
  verified in isolation during research; not covered by this test suite
- benchmark comparison against fastmcp-TS `fromOpenAPI` / ClawQL (the Python
  repo's comparison/ methodology ports directly)
- ready-made IdP adapters inside the library (Python fastmcp ships
  GitHub/Google/Auth0/Keycloak providers; the TS SDK is Resource-Server-side
  only, so the library takes an AS metadata object + `verifyToken`). The
  **example** wires a real IdP — `better-auth` supplies GitHub login and the
  OAuth 2.1 Authorization Server; see *The example app* under Dev.

## Dev

```bash
npm install
npm test          # 18 unit + 72 e2e checks (plain node — type stripping, no bundler)
npm run test:cov  # the same under c8 — line/branch coverage for src/
npm run example   # notes demo on :8020 — REST + Swagger + GitHub login + OAuth-gated /mcp + GraphiQL
npm run example:oauth   # the fastapi-gql-mcp notes_oauth port (examples/notes_oauth), same :8020
HONO_GQL_MCP_OTEL=1 npm run example   # + route spans under graphql.execute
npm run typecheck # noEmit — the repo runs from source
npm run build     # emit dist/ for publishing
```

`npm test` needs non-empty `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`, because
the example wires GitHub login and the `/mcp` gate only when both are set — and
one check asserts that gate's 401 challenge. Placeholders are enough; the suite
never calls GitHub. With `example/.env` present locally this is already the case.
CI passes them as job-level env.

`npm test` runs against a throwaway database (`test/.tmp/e2e.sqlite`, set by
`test/e2e.env` and deleted at the start of each run), so it never touches the
demo's `example/data.sqlite` and counts are exact on every run. To point the
example at another file, set `SQLITE_PATH`.

### The example app

`example/` is a notes service a browser user and an agent both reach. It shows
the two integrations the library leaves to the host:

| Surface | Auth | How |
| --- | --- | --- |
| REST docs (`/docs`, `/openapi.json`) | none (public) | Swagger UI over the OpenAPI 3.1 document `app.doc31()` derives from the same `createRoute()` definitions the bridge reads |
| REST / GraphQL (browser, GraphiQL) | GitHub login | `better-auth` session cookie; `resolveUser` reads it |
| MCP (`/mcp`) | OAuth 2.1 | `better-auth` `mcp()` plugin is the Authorization Server; the bridge's `verifyToken` checks its JWTs |
| Route calls (inside GraphQL/MCP) | the caller's own header | `passthroughHeaders: ['authorization', 'cookie']` |

One source, many views: the same `createRoute()` / `bridgeValidator()` route
definitions feed the REST handlers, the Swagger document, and the derived
GraphQL schema — nothing is declared twice. A recursive `z.lazy` schema must
carry a `.meta({ id })` so the OpenAPI build emits a `$ref` instead of
inlining forever (without it `getOpenAPIDocument()` overflows the stack —
`/categories` is the worked example).

`better-auth` supplies browser login (GitHub social) **and** the OAuth 2.1
Authorization Server (`/api/auth/oauth2/authorize|token|register`, RFC 8414 +
9728 discovery, PKCE, JWT via JWKS) from one handler. The bridge stays
Resource-Server-side: it is handed the AS metadata (`asMetadata`) and a
`verifyToken` (JWKS signature + issuer + audience), nothing more.

Setup:

1. GitHub → Developer settings → OAuth Apps → New. Homepage
   `http://localhost:8020`; **Authorization callback URL**
   `http://localhost:8020/api/auth/callback/github`.
2. `cp example/.env.example example/.env`, fill `GITHUB_CLIENT_ID` /
   `GITHUB_CLIENT_SECRET`, set `BETTER_AUTH_SECRET` (`openssl rand -hex 32`).
3. `npm run example`. With creds empty the app still runs: REST/GraphQL stay
   open and `/mcp` is ungated.

Notes are **per-user**: a note carries an owner, and someone else's note is a
404 — it does not exist for you. Persistence is a single SQLite file
(`example/data.sqlite`, gitignored): better-auth's tables (users, sessions,
JWKS, OAuth clients/tokens) and the demo's `notes` share it, so notes AND the
MCP login survive restarts. Delete the file for a factory reset.

An agent connects with the standard MCP OAuth flow — `POST /mcp` answers 401
with `WWW-Authenticate: Bearer resource_metadata=...`, the client discovers
`/.well-known/oauth-protected-resource/mcp` → `/.well-known/oauth-authorization-server`,
registers (DCR or a Client ID Metadata Document), runs the browser login +
consent, and sends the resulting JWT as its Bearer. One token, two checks: the
same JWT passes the gate and reaches the routes.

### The notes_oauth port (examples/notes_oauth)

`examples/notes_oauth/` is the byte-compatible port of fastapi-gql-mcp's
`notes_oauth` demo: same port (8020), same `.env` keys, same
`base64url(json).hex_hmac` session-token format — swap the two servers behind
one GitHub OAuth App and tokens minted by either side verify on both (same
`SESSION_SECRET`). Where `example/` integrates better-auth as the
Authorization Server, this one hand-rolls the flow the way the Python demo
does, for side-by-side behavior verification: `npm run example:oauth`,
`npm run smoke:oauth` (headless full-flow check).


The runner is plain `node` (Node ≥ 22.18 strips types natively), not tsx —
a bundler-style resolver loads two `@opentelemetry/api` instances from its
exports map and silently breaks span nesting (see the Observability notes).

Note the two runtimes this repo has: `npm test` and `npm run example` execute
the TypeScript **sources** directly (Node's type stripping — that is why the
code avoids parameter properties), while consumers of the published package get
the emitted `dist/`. `npm run typecheck` follows the sources; `npm run build`
is the only thing that reads `tsconfig.build.json`.
