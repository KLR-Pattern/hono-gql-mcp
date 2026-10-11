# Changelog

## 0.2.1 (2026-10-11)

**Fixed** — both found by the new kitchen-sink battery; both crashed
construction with a raw graphql-js error, so the wrapped app failed to boot:

- A wire argument name that is not a legal GraphQL identifier (e.g. a
  hyphenated path param `/orders/{order-id}`). Arg names are now sanitized
  for the schema (`order_id`) and translated back to the wire name at
  execution — the route stays callable. Two params sanitizing onto the same
  name skip the route with an explicit reason.
- Object schemas whose KEYS are not legal identifiers (e.g.
  `{'content-type': …}`) now degrade to the JSON scalar with a recorded
  reason (input values cannot be translated back before the route's own
  validation, so degrading is the honest bucket).

**Added**

- `examples/kitchen-sink` + `npm run smoke:sink` — a 22-route coverage
  battery (CRUD shapes, nested/multi tags, recursion, unions, nativeEnum,
  edge buckets, sub-app mounting) with an anomaly report: startup audit, an
  executable document per derived field, REST-vs-GraphQL parity, and the
  suspicious edges. Example-only; no library surface change.

## 0.2.0 (2026-10-11)

**Added**

- `hostValidation` option — configurable Host/Origin allowlists for the MCP
  endpoint (DNS-rebinding and cross-site protection beyond the localhost
  defaults; `[]` disables either half).
- `mountGraphQL({ graphiql: false })` and `cdnBase` — skip the playground
  route entirely, or point its importmap at a self-hosted esm.sh-compatible
  mirror for offline/air-gapped deployments.
- `DuplicateFieldError` is an exported class; catch construction-time field
  collisions by type (the message keeps the old string prefix).
- `graphql_mutation`'s description carries the same derived, validated
  example document `graphql_query` has — required args filled with minimal
  literals, optionals omitted so route defaults run.
- Progressive-mode domain SDL fragments are cached per handler instead of
  being rebuilt on every `get_query_schema`.

**Fixed**

- Tool-description sample documents: the runtime `GraphQLField.args` array
  was read as a record, so any first field WITH arguments produced index
  keys (`0: ""`) and the sample silently disappeared.
- Hardening knobs are validated at construction — `maxConcurrency: 0`
  deadlocked every route call behind a never-granted permit and
  `requestTimeoutMs: 0` aborted every call instantly; both (and `maxDepth` /
  `documentCacheSize`) now throw `HonoGqlMcpConfigError` before anything is
  derived.
- Routes with a required header/cookie parameter are skipped with an
  explicit reason instead of deriving a GraphQL field that could never be
  called correctly.
- One shared `GraphQLEnumType` instance per `z.enum` schema — the SDL no
  longer carries `Speed`/`Speed_2` duplicate enums.
- The `sharedSecret` gate compares in constant time.
- `/graphql`: `variables` reach execution, and non-JSON content types are
  refused with 415 (a cross-site form POST can no longer reach the executor).

**Internal**

- The MCP tool implementation split into `mcp-tools` / `mcp-progressive`
  (no public API change); test suite is 18 unit + 75 e2e checks with c8
  coverage wired (`npm run test:cov`).

## 0.1.1 (2026-10-11)

Build and publish pipeline (`tsconfig.build.json`, dist emit, OIDC trusted
publishing), serial mutations in document order, GraphiQL on pinned ESM with
the Explorer plugin, introspection exemption in `max_depth`, array query
args as repeated keys, `renames` in `readiness()`, `/graphql` variables and
content-type checks, constant-time `sharedSecret`.

## 0.1.0 (2026-10-10)

Initial import — Hono + Zod → GraphQL → MCP bridge: scanner, Zod→GraphQL
mapper, domain grouping, in-process executor, progressive disclosure,
hardening, auth gate with RFC 9728 discovery, OTel waterfall.
