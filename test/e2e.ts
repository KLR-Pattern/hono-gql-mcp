/**
 * End-to-end walkthrough — the fastapi-gql-mcp test spirit, ported.
 *
 * Direct GraphQL face: composition, field selection, partial failure,
 * per-caller auth, recursion, Boolean success, mutation gating.
 * MCP face: full in-process round trip over the real streamable HTTP
 * transport (custom fetch → app.request), proving the constant tool set and
 * end-to-end credential passthrough.
 */
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Hono } from 'hono'
import { DB_PATH, DEMO_OWNER } from '../example/store.ts'

// Verify isolation BEFORE loading the app: SQLITE_PATH points at test/.tmp/…
// (test/e2e.env), and the file is cleared so counts are exact per run.
// A body of accumulated state used to push a fresh row out of a 10-item window.
for (const suffix of ['', '-wal', '-shm']) rmSync(`${DB_PATH}${suffix}`, { force: true })

const { createApp } = await import('../example/app.ts')
import { parse, validate } from 'graphql'
import { bridgeValidator, documentDepth, HonoGqlMcp, LruCache, RouterGraphQLHandler, zValidator } from '../src/index.ts'

const tests: Array<[name: string, fn: () => void | Promise<void>]> = []
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn])

/** graphql-js types query data as a loose map — tests read it as any. */
const d = (r: { data?: unknown }): any => r.data

// -- shared fixtures ------------------------------------------------------------
const { app, bridge, auth, store } = await createApp()
const handler = bridge.handler

/**
 * The example app authenticates every note route, so every request needs a
 * real Bearer. Tests mint one with the app's own auth instance (no GitHub
 * round trip) — the mirror of the Python example's smoke script. `DEMO_OWNER`
 * makes the seeded notes visible.
 */
const signToken = auth.signToken
const AUTH = { authorization: `Bearer ${await signToken(DEMO_OWNER)}` }
const gql = (query: string, headers: Record<string, string> = AUTH) =>
  handler.execute(query, undefined, { headers })

// -- direct GraphQL face --------------------------------------------------------

test('composition: one query spans three domains (nested tag included)', async () => {
  const result = await gql(`{
    notes     { list_notes(limit: 2) { id title } }
    analytics { stats { total } }
    catalog   { tree { categories { name } } }
  }`)
  assert.deepEqual(result.errors, undefined)
  assert.equal(d(result).notes.list_notes.length, 2)
  assert.ok(d(result).analytics.stats.total >= 3)
  assert.ok(d(result).catalog.tree.categories.length >= 2)
})

test('field selection: only asked-for fields come back', async () => {
  const result = await gql(`{ notes { get_note(id: "n1") { title } } }`)
  assert.deepEqual(Object.keys(d(result).notes.get_note ?? {}), ['title'])
})

test('partial failure: a failing route nulls only its own field', async () => {
  const result = await gql(`{
    notes { get_note(id: "missing") { title }  list_notes { id } }
  }`)
  assert.ok(result.errors?.[0]?.message.startsWith('HTTP_404'), result.errors?.[0]?.message)
  assert.equal(d(result).notes.get_note, null)
  assert.ok((d(result).notes.list_notes?.length ?? 0) >= 1)
})

test('per-caller auth: no credentials → HTTP_401 field errors', async () => {
  const result = await handler.execute(`{ notes { list_notes { id } } }`)
  assert.ok(result.errors?.some((e) => e.message.startsWith('HTTP_401')), JSON.stringify(result.errors))
})

test('recursion: z.lazy category tree serves true depth', async () => {
  const result = await gql(`{
    catalog { tree { categories { name children { name children { name } } } } }
  }`)
  const names = JSON.stringify(d(result))
  assert.ok(names.includes('quickstart'), names)
  // the schema itself declares the recursion
  assert.ok(handler.getSDL().includes('children: [Category!]'), 'recursive field in SDL')
})

test('Boolean success: 204-style delete bridges as true', async () => {
  const result = await gql(`mutation { notes { delete_note(id: "n3") } }`)
  assert.equal(d(result).notes.delete_note, true)
})

test('degradation audit: dynamic record field lands in the JSON bucket, with a notice', async () => {
  assert.ok(handler.getSDL().includes('by_tag: JSON'))
  assert.ok(handler.degradedFields.some(([where, reason]) => where.includes('by_tag') && reason.includes('JSON')))
})

test('mutation gating: allowMutation=false drops writes from the schema', async () => {
  const readonly = new RouterGraphQLHandler(app, { allowMutation: false })
  assert.ok(!readonly.getSDL().includes('type Mutation'))
  const result = await readonly.execute(`mutation { notes { delete_note(id: "n1") } }`)
  assert.ok((result.errors?.length ?? 0) > 0, 'mutation document must fail validation')
})

// -- MCP face (full in-process round trip) --------------------------------------

/** A real MCP client speaking streamable HTTP into an app, no sockets. */
async function mcpClient(headers: Record<string, string>, target: Hono<any, any, any> = app, path = '/mcp') {
  const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:8100${path}`), {
    // In-process fetch: hand each request to app.request. The Host header is
    // set explicitly — a fetch Request only gains it at network time, and the
    // SDK's DNS-rebinding protection validates it.
    fetch: ((input: string | URL | Request, init?: RequestInit) => {
      const req = new Request(input, init)
      req.headers.set('host', 'localhost:8100')
      return target.request(req)
    }) as typeof fetch,
    requestInit: { headers },
  })
  const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} })
  await client.connect(transport)
  return { client, transport }
}

const callToolText = async (client: Client, name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>
  }
  assert.equal(result.content[0].type, 'text')
  return result.content[0].text
}

test('MCP: constant tool catalog with agent annotations', async () => {
  const { client, transport } = await mcpClient(AUTH)
  const { tools } = await client.listTools()
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['get_schema', 'graphql_mutation', 'graphql_query'],
  )
  const byName = new Map(tools.map((t) => [t.name, t]))
  assert.equal(byName.get('get_schema')?.annotations?.readOnlyHint, true)
  assert.equal(byName.get('graphql_query')?.annotations?.readOnlyHint, true)
  assert.equal(byName.get('graphql_mutation')?.annotations?.destructiveHint, true)
  await client.close()
  await transport.close()
})

test('MCP: get_schema returns the derived SDL', async () => {
  const { client, transport } = await mcpClient(AUTH)
  const sdl = await callToolText(client, 'get_schema', {})
  assert.ok(sdl.includes('NotesQuery') && sdl.includes('type Note'), sdl.slice(0, 200))
  await client.close()
  await transport.close()
})

test('MCP: graphql_query composes domains in one tool call', async () => {
  const { client, transport } = await mcpClient(AUTH)
  const raw = await callToolText(client, 'graphql_query', {
    query: `{ notes { list_notes(limit: 2) { title } } analytics { stats { total } } }`,
  })
  const result = JSON.parse(raw)
  assert.equal(result.errors, undefined)
  assert.equal(result.data.notes.list_notes.length, 2)
  assert.ok(result.data.analytics.stats.total >= 2)
  await client.close()
  await transport.close()
})

test('MCP: per-caller credentials reach the routes end-to-end', async () => {
  // The example's /mcp is OAuth-gated, so mount a second, UNgated bridge to
  // isolate the route-level check: with no credentials the passthrough
  // delivers nothing and the routes answer 401 — proving the bridge holds no
  // credentials of its own.
  const fresh = await createApp()
  const open = new HonoGqlMcp(fresh.app, { name: 'open', allowMutation: true })
  open.mountTo(fresh.app, '/mcp-open')
  const { client, transport } = await mcpClient({}, fresh.app, '/mcp-open')
  const raw = await callToolText(client, 'graphql_query', {
    query: `{ notes { list_notes { id } } }`,
  })
  const result = JSON.parse(raw)
  assert.ok(
    result.errors?.some((e: { message: string }) => e.message.startsWith('HTTP_401')),
    raw,
  )
  await client.close()
  await transport.close()
})

test('MCP: graphql_mutation writes, then the write is visible', async () => {
  const { client, transport } = await mcpClient(AUTH)
  // Unique tag per run: the store is PERSISTENT now, so a fixed fixture would
  // collide with rows left by earlier runs.
  const tag = `mcp-${Date.now()}`
  const created = JSON.parse(
    await callToolText(client, 'graphql_mutation', {
      query: `mutation { notes { create_note(body: { title: "from MCP", tags: ["${tag}"] }) { id title } } }`,
    }),
  )
  assert.equal(created.errors, undefined)
  assert.equal(created.data.notes.create_note.title, 'from MCP')

  const listed = JSON.parse(
    await callToolText(client, 'graphql_query', {
      query: `{ notes { list_notes(tag: "${tag}") { title } } }`,
    }),
  )
  assert.deepEqual(listed.data.notes.list_notes, [{ title: 'from MCP' }])
  await client.close()
  await transport.close()
})

test('MCP: graphql_query refuses mutation documents, and nothing executes', async () => {
  const { client, transport } = await mcpClient(AUTH)
  // Tool errors are reported in-band (isError), per the MCP spec.
  const result = (await client.callTool({
    name: 'graphql_query',
    arguments: { query: `mutation { notes { delete_note(id: "n1") } }` },
  })) as { isError?: boolean; content: Array<{ type: string; text: string }> }
  assert.equal(result.isError, true)
  assert.ok(result.content[0].text.includes('refuses mutation documents'), result.content[0].text)
  // The refused write never ran — the note is still there.
  const after = JSON.parse(
    await callToolText(client, 'graphql_query', { query: `{ notes { get_note(id: "n1") { title } } }` }),
  )
  assert.equal(after.data.notes.get_note.title, 'Buy milk')
  await client.close()
  await transport.close()
})

// -- hardening -------------------------------------------------------------------

/** A dedicated app: a counting slow route (measures real in-flight concurrency) + an instant route. */
function slowApp() {
  const app = new OpenAPIHono()
  let inFlight = 0
  let maxInFlight = 0
  const ok = (extra: Record<string, unknown>) => ({
    description: 'ok',
    content: { 'application/json': { schema: z.object(extra) } },
  })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/slow/{ms}',
      tags: ['bench'],
      operationId: 'slow',
      request: { params: z.object({ ms: z.coerce.number().int() }) },
      responses: { 200: ok({ slept: z.boolean() }) },
    }),
    async (c) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, c.req.valid('param').ms))
      inFlight--
      return c.json({ slept: true }, 200)
    },
  )
  app.openapi(
    createRoute({
      method: 'get',
      path: '/fast',
      tags: ['bench'],
      operationId: 'fast',
      responses: { 200: ok({ ok: z.boolean() }) },
    }),
    (c) => c.json({ ok: true }, 200),
  )
  return { app, maxObserved: () => maxInFlight }
}

test('hardening: requestTimeoutMs — a slow field surfaces TIMEOUT, its sibling survives', async () => {
  const { app } = slowApp()
  const h = new RouterGraphQLHandler(app, { requestTimeoutMs: 60 })
  const result = await h.execute(`{ bench { slow(ms: 500) { slept } fast { ok } } }`)
  assert.ok(result.errors?.some((e) => e.message.startsWith('TIMEOUT')), JSON.stringify(result.errors))
  assert.equal(d(result).bench.fast.ok, true)
  assert.equal(d(result).bench.slow, null)
})

test('hardening: maxConcurrency bounds in-flight route calls across the fan-out', async () => {
  const { app, maxObserved } = slowApp()
  const h = new RouterGraphQLHandler(app, { requestTimeoutMs: null, maxConcurrency: 2 })
  const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((alias) => `${alias}: slow(ms: 60) { slept }`).join(' ')
  const result = await h.execute(`{ bench { ${six} } }`)
  assert.equal(result.errors, undefined)
  assert.ok(maxObserved() <= 2, `in-flight peaked at ${maxObserved()}, limit is 2`)
  assert.ok(maxObserved() >= 2, 'sibling fields did run in parallel up to the cap')
})

test('hardening: queue waits count against requestTimeoutMs', async () => {
  const { app } = slowApp()
  const h = new RouterGraphQLHandler(app, { requestTimeoutMs: 150, maxConcurrency: 1 })
  const three = ['a', 'b', 'c'].map((alias) => `${alias}: slow(ms: 80) { slept }`).join(' ')
  const result = await h.execute(`{ bench { ${three} } }`)
  // a starts at t=0 and finishes at 80ms — survives; b and c queue past the 150ms deadline.
  assert.equal(d(result).bench.a.slept, true)
  const timeouts = result.errors?.filter((e) => e.message.startsWith('TIMEOUT')) ?? []
  assert.ok(timeouts.length >= 1, JSON.stringify(result.errors))
})

test('hardening: max_depth rejects runaway nesting before anything executes', async () => {
  // Category recursion makes selectable depth unbounded — 13 levels.
  const deep = `{ catalog { tree { categories { ${'children { '.repeat(11)}name ${'} '.repeat(11)} } } } }`
  // The default handler (maxDepth 10) rejects the document before execution.
  const limited = await handler.execute(deep, undefined, { headers: AUTH })
  assert.ok(limited.errors?.some((e) => e.message.includes('max_depth')), JSON.stringify(limited.errors))

  const unlimited = new RouterGraphQLHandler(app, { maxDepth: null, allowMutation: true })
  const ok = await unlimited.execute(deep, undefined, { headers: AUTH })
  assert.equal(ok.errors, undefined)
})

test('hardening: introspection is exempt from max_depth (GraphiQL/codegen work at the default)', async () => {
  // The canonical client introspection query nests ~16 through `ofType` — past
  // maxDepth's default of 10. Without the exemption every tool that reads the
  // schema (GraphiQL first among them) fails at the default.
  const introspection = `query IntrospectionQuery { __schema { queryType { name } types { ...FullType } } }
    fragment FullType on __Type { kind name fields(includeDeprecated: true) { name type { ...TypeRef } } }
    fragment TypeRef on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`
  const result = await handler.execute(introspection, undefined, { headers: AUTH })
  assert.equal(result.errors, undefined, JSON.stringify(result.errors))
  assert.ok((d(result).__schema?.types?.length ?? 0) > 0, 'schema types returned at the default depth')
  // `__type` (single-type shorthand) is exempt too.
  const oneType = `{ __type(name: "Note") { kind name ofType { kind name } } }`
  assert.equal((await handler.execute(oneType, undefined, { headers: AUTH })).errors, undefined)
})

test('hardening: LruCache — recency refresh, capacity bound, 0 disables', () => {
  const lru = new LruCache<string>(2)
  lru.set('a', '1')
  lru.set('b', '2')
  assert.equal(lru.get('a'), '1') // refresh a
  lru.set('c', '3') // evicts b (least recent)
  assert.equal(lru.size, 2)
  assert.equal(lru.get('a'), '1')
  assert.equal(lru.get('b'), undefined)

  const off = new LruCache<string>(0)
  off.set('a', '1')
  assert.equal(off.get('a'), undefined)
})

test('hardening: mutations run SERIALLY in document order despite domain grouping', async () => {
  // The spec serializes ROOT mutation fields. Tags wrap writes in a group
  // object type, so the root holds one group field and the writes beneath it
  // would run CONCURRENTLY — the guarantee was lost by the grouping. The
  // resolver-side SerialQueue restores it; this pins that.
  const order: string[] = []
  const app3 = new OpenAPIHono()
  app3.openapi(
    createRoute({
      method: 'get',
      path: '/readable',
      tags: ['read'],
      operationId: 'readable',
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    }),
    (c) => c.json({ v: 'x' }, 200),
  )
  // `a` sleeps longest, so a concurrent run would finish it LAST.
  for (const n of ['a', 'b', 'c']) {
    app3.openapi(
      createRoute({
        method: 'post',
        path: `/w${n}`,
        tags: ['writes'],
        operationId: `w_${n}`,
        responses: { 200: okResponse(z.object({ v: z.string() })) },
      }),
      async (c) => {
        order.push(`start:${n}`)
        await new Promise((r) => setTimeout(r, n === 'a' ? 60 : 5))
        order.push(`end:${n}`)
        return c.json({ v: n }, 200)
      },
    )
  }
  const h = new RouterGraphQLHandler(app3, { allowMutation: true })
  const result = await h.execute(`mutation { writes { w_a { v } w_b { v } w_c { v } } }`)
  assert.equal(result.errors, undefined)
  assert.equal(order.join(','), 'start:a,end:a,start:b,end:b,start:c,end:c', order.join(' '))
})

test('hardening: array query args travel as repeated keys, not a joined string', async () => {
  // URLSearchParams.set() would send ?tags=a%2Cb and the route's own
  // z.array(z.string()) validation would answer 400. GraphQL sends a JSON
  // array; it has to become ?tags=a&tags=b.
  let seen: unknown = null
  const app4 = new OpenAPIHono()
  app4.openapi(
    createRoute({
      method: 'get',
      path: '/search',
      tags: ['q'],
      operationId: 'search',
      request: { query: z.object({ tags: z.array(z.string()).optional(), q: z.string().optional() }) },
      responses: { 200: okResponse(z.object({ got: z.string() })) },
    }),
    (c) => {
      seen = c.req.valid('query')
      return c.json({ got: 'ok' }, 200)
    },
  )
  const h = new RouterGraphQLHandler(app4)
  const result = await h.execute(`{ q { search(tags: ["a", "b"], q: "x") { got } } }`)
  assert.equal(result.errors, undefined, JSON.stringify(result.errors))
  assert.deepEqual(seen, { tags: ['a', 'b'], q: 'x' })
})

test('config: an empty type Query is reported, not thrown at request time', async () => {
  // A write-only app (or filters that kept nothing) leaves `type Query` with no
  // fields — graphql-js then considers the whole schema invalid. Construction
  // must still succeed (the library's own filters can produce this state), and
  // execute() must answer with a typed error rather than a raw Error.
  const writesOnly = new OpenAPIHono()
  writesOnly.openapi(
    createRoute({
      method: 'post',
      path: '/w',
      tags: ['w'],
      operationId: 'w',
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    }),
    (c) => c.json({ v: 'x' }, 200),
  )
  const h = new RouterGraphQLHandler(writesOnly, { allowMutation: true })
  assert.equal(h.hasQueryOperations, false)
  const result = await h.execute(`{ __typename }`)
  assert.ok(result.errors?.[0]?.message.startsWith('NO_QUERY_OPERATIONS'), JSON.stringify(result.errors))

  // Filters that drop every read route reach the same state.
  const filtered = new RouterGraphQLHandler(filterApp(), { includeTags: ['nomatch'] })
  assert.equal(filtered.hasQueryOperations, false)
  // A normal app is unaffected.
  assert.equal(new RouterGraphQLHandler(filterApp()).hasQueryOperations, true)
})

test('readiness: a type-name rename is reported but does NOT block ready', async () => {
  // GraphQL has one global type namespace, so two schemas sharing a
  // .meta({ title }) force a rename. That costs no capability, so it must not
  // flip `ready` — otherwise an `assert report.ready` CI gate fails on a
  // harmless collision and gets turned off.
  const A = z.object({ v: z.string() }).meta({ title: 'Item' })
  const B = z.object({ w: z.string() }).meta({ title: 'Item' })
  const app5 = new OpenAPIHono()
  for (const [path, schema, id] of [['/a', A, 'op_a'], ['/b', B, 'op_b']] as const) {
    app5.openapi(
      createRoute({ method: 'get', path, tags: ['t'], operationId: id, responses: { 200: okResponse(schema) } }),
      (c) => c.json({ v: 'x' }, 200),
    )
  }
  const h = new RouterGraphQLHandler(app5)
  const report = h.readiness()
  assert.equal(report.degradedFields.length, 0, 'a rename is not a degradation')
  assert.ok(report.renames.some(([name, reason]) => name === 'Item' && reason.includes('Item_2')), JSON.stringify(report.renames))
  assert.equal(report.ready, true, 'a rename must not make the bridge unready')
})

test('hardening: fragments do not add to maxDepth', async () => {
  // An inline fragment and a spread both contribute to the SAME selection set;
  // GraphQL inlines them before execution. Counting a level for either made a
  // fragment-organized document measure deeper than the identical inline one.
  const app6 = new OpenAPIHono()
  app6.openapi(
    createRoute({
      method: 'get',
      path: '/c',
      tags: ['t'],
      operationId: 'c',
      responses: { 200: okResponse(z.object({ name: z.string() })) },
    }),
    (c) => c.json({ name: 'x' }, 200),
  )
  const h = new RouterGraphQLHandler(app6)
  const inline = `{ t { c { name } } }`
  const viaFragment = `query { ...F } fragment F on Query { t { c { name } } }`
  const viaInlineFragment = `{ ... on Query { t { c { name } } } }`
  assert.equal(documentDepth(parse(inline)), 3)
  assert.equal(documentDepth(parse(viaFragment)), 3, 'a spread adds no depth')
  assert.equal(documentDepth(parse(viaInlineFragment)), 3, 'an inline fragment adds no depth')
  for (const doc of [inline, viaFragment, viaInlineFragment]) {
    assert.equal((await h.execute(doc)).errors, undefined, doc)
  }
  // Real nesting is still enforced.
  const limited = new RouterGraphQLHandler(app6, { maxDepth: 2 })
  assert.ok((await limited.execute(inline)).errors?.some((e) => e.message.includes('max_depth')))
})

test('MCP: the graphql_query example is a real, executable document', async () => {
  // The description is read by an LLM that copies it verbatim — a hardcoded
  // example goes stale as soon as an operationId or response schema changes.
  const big = bigApp()
  const bridge = new HonoGqlMcp(big, { name: 'example-check' })
  bridge.mountTo(big, '/mcp-example')
  const { client, transport } = await mcpClient({}, big, '/mcp-example')
  const { tools } = await client.listTools()
  const described = tools.find((t) => t.name === 'graphql_query')?.inputSchema as
    | { properties?: { query?: { description?: string } } }
    | undefined
  const example = described?.properties?.query?.description?.match(/e\.g\. (.+)$/)?.[1]
  assert.ok(example, `no example in the description: ${described?.properties?.query?.description}`)
  // It must be valid AND runnable against this very app.
  assert.deepEqual(validate(bridge.handler.schema, parse(example)), [])
  const result = JSON.parse(await callToolText(client, 'graphql_query', { query: example }))
  assert.equal(result.errors, undefined, JSON.stringify(result.errors))
  await client.close()
  await transport.close()
})

test('hardening: document cache caches the front half — execution stays live', async () => {
  const h = new RouterGraphQLHandler(app, { allowMutation: true })
  // Unique title marker: the store persists, and sibling tests write notes too —
  // count deltas are only deterministic scoped to this test's own row.
  const marker = `cache-check-${Date.now()}`
  const q = (t: string) => `{ notes { get_search(q: "${t}") { title } } }`
  const before = await h.execute(q(marker), undefined, { headers: AUTH })
  await h.execute(
    `mutation { notes { create_note(body: { title: "${marker}" }) { id } } }`,
    undefined,
    { headers: AUTH },
  )
  const after = await h.execute(q(marker), undefined, { headers: AUTH }) // same document — cache hit on parse/validate
  assert.equal(d(after).notes.get_search.length, d(before).notes.get_search.length + 1)
})

// -- route filters + multi-domain ---------------------------------------------------

const okResponse = (schema: z.ZodTypeAny) => ({
  description: 'ok',
  content: { 'application/json': { schema } },
})

/** Routes exercising every filter dimension: tags, untagged, deprecated, writes. */
function filterApp() {
  const app = new OpenAPIHono()
  const V = z.object({ v: z.string() })
  const route = (
    method: 'get' | 'post',
    path: string,
    operationId: string,
    tags: string[] | undefined,
    extra: { deprecated?: boolean } = {},
  ) =>
    app.openapi(
      {
        method,
        path,
        ...(tags ? { tags } : {}),
        operationId,
        ...(extra.deprecated ? { deprecated: true } : {}),
        responses: { 200: okResponse(V) },
      } as Parameters<typeof createRoute>[0],
      (c) => c.json({ v: operationId }, 200),
    )
  route('get', '/users', 'list_users', ['iam:users'])
  route('post', '/users', 'create_user', ['iam:users'])
  route('get', '/invoices', 'list_invoices', ['billing:invoice'])
  route('post', '/invoices', 'create_invoice', ['billing:invoice'])
  route('get', '/health', 'health', undefined)
  route('get', '/legacy', 'legacy_op', ['legacy'], { deprecated: true })
  return app
}

test('filters: include_tags is a strict whitelist — untagged routes drop', () => {
  const h = new RouterGraphQLHandler(filterApp(), { includeTags: ['iam:*'] })
  const sdl = h.getSDL()
  assert.ok(sdl.includes('list_users'))
  assert.ok(!sdl.includes('list_invoices'))
  assert.ok(!sdl.includes('health'), 'untagged routes drop under a tag whitelist')
  assert.deepEqual(h.domains, ['iam'])
})

test('filters: exclude_tags wins, and alone keeps untagged routes', () => {
  const h = new RouterGraphQLHandler(filterApp(), { excludeTags: ['billing:*'] })
  const sdl = h.getSDL()
  assert.ok(!sdl.includes('list_invoices'))
  assert.ok(sdl.includes('list_users'))
  assert.ok(sdl.includes('health'), 'untagged routes stay when only exclude_tags is set')
})

test('filters: include/exclude path globs (fnmatch, * crosses /)', () => {
  const h = new RouterGraphQLHandler(filterApp(), { include: ['/use*'] })
  assert.ok(h.getSDL().includes('list_users'))
  assert.ok(!h.getSDL().includes('list_invoices'))

  const h2 = new RouterGraphQLHandler(filterApp(), { exclude: ['/invoices'] })
  assert.ok(!h2.getSDL().includes('list_invoices'))
  assert.ok(h2.getSDL().includes('list_users'))
})

test('filters: exclude_deprecated drops the route; staying routes keep @deprecated', () => {
  const staying = new RouterGraphQLHandler(filterApp())
  assert.ok(staying.getSDL().includes('@deprecated'), 'GraphQL-native deprecation mark travels')

  const dropped = new RouterGraphQLHandler(filterApp(), { excludeDeprecated: true })
  assert.ok(!dropped.getSDL().includes('legacy_op'))
  assert.ok(dropped.getSDL().includes('list_users'))
})

test('filters: mutation_include whitelists which write routes expose', () => {
  const h = new RouterGraphQLHandler(filterApp(), {
    allowMutation: true,
    mutationInclude: ['/users'],
  })
  const sdl = h.getSDL()
  assert.ok(sdl.includes('create_user'))
  assert.ok(!sdl.includes('create_invoice'))
  assert.ok(
    h.skips.some((s) => s.path === '/invoices' && s.reason.includes('mutation_include')),
    JSON.stringify(h.skips),
  )
})

test('multi-domain: a two-tag route lands in both domain groups', () => {
  const app = new OpenAPIHono()
  app.openapi(
    {
      method: 'get',
      path: '/shared',
      tags: ['alpha', 'beta'],
      operationId: 'shared_op',
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    } as Parameters<typeof createRoute>[0],
    (c) => c.json({ v: 'x' }, 200),
  )
  const h = new RouterGraphQLHandler(app)
  const sdl = h.getSDL()
  assert.ok(sdl.includes('alpha: AlphaQuery!') && sdl.includes('beta: BetaQuery!'))
  assert.equal((sdl.match(/shared_op/g) ?? []).length, 2, 'the field appears under both groups')
})

// -- progressive disclosure ----------------------------------------------------------

/** 30 typed routes across 3 domains — above the auto threshold of 25. */
function bigApp() {
  const app = new OpenAPIHono()
  const Item = z.object({ id: z.string() }).meta({ title: 'Item' })
  for (let i = 0; i < 30; i++) {
    app.openapi(
      createRoute({
        method: 'get',
        path: `/res${i}`,
        tags: [`grp${Math.floor(i / 10)}`],
        operationId: `get_res_${i}`,
        responses: { 200: okResponse(Item) },
      }),
      (c) => c.json({ id: `r${i}` }, 200),
    )
  }
  return app
}

const envelope = (raw: string): any => JSON.parse(raw)

test('progressive: mode=auto switches above the threshold', async () => {
  assert.equal(new HonoGqlMcp(bigApp()).resolvedMode, 'progressive')
  assert.equal(new HonoGqlMcp(bigApp(), { progressiveThreshold: 35 }).resolvedMode, 'simple')
  assert.equal(new HonoGqlMcp(bigApp(), { mode: 'simple' }).resolvedMode, 'simple')
  const { app } = await createApp()
  assert.equal(new HonoGqlMcp(app, { allowMutation: true, progressiveThreshold: 5 }).resolvedMode, 'progressive')
})

test('progressive: constant 4-tool catalog (no get_schema), full walkthrough works', async () => {
  const big = bigApp()
  const bridge = new HonoGqlMcp(big, { name: 'big-api' })
  bridge.mountTo(big, '/mcp')
  const { client, transport } = await mcpClient({}, big)

  const { tools } = await client.listTools()
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['get_query_schema', 'graphql_query', 'list_domains', 'list_queries'],
  )

  // Layer 1: list_domains
  const domains = envelope(await callToolText(client, 'list_domains', {}))
  assert.equal(domains.success, true)
  assert.equal(domains.data.domains.length, 3)
  assert.deepEqual(
    domains.data.domains.map((d: any) => d.name),
    ['grp0', 'grp1', 'grp2'],
  )
  assert.equal(domains.data.domains[0].queries, 10)

  // Layer 2: list_queries
  const queries = envelope(await callToolText(client, 'list_queries', { domain: 'grp0' }))
  assert.equal(queries.success, true)
  assert.equal(queries.data.queries.length, 10)
  assert.equal(queries.data.queries[0].name, 'get_res_0')
  assert.equal(queries.data.queries[0].type, 'Item')

  // Layer 3: get_query_schema — the sibling-free fragment
  const schemaRes = envelope(await callToolText(client, 'get_query_schema', { domain: 'grp0' }))
  const sdl: string = schemaRes.data.sdl
  assert.ok(sdl.includes('grp0: Grp0Query!'), sdl)
  assert.ok(sdl.includes('get_res_0'))
  assert.ok(!sdl.includes('get_res_10'), 'other domains stay out of the fragment')
  assert.ok(!sdl.includes('grp1'))

  // Unknown domain → DOMAIN_NOT_FOUND envelope with available domains
  const unknown = envelope(await callToolText(client, 'list_queries', { domain: 'nope' }))
  assert.equal(unknown.success, false)
  assert.equal(unknown.error_type, 'DOMAIN_NOT_FOUND')
  assert.ok(unknown.hint.includes('grp0'))

  // Layer 4: execution stays UNscoped — cross-domain composition in one query
  const result = envelope(
    await callToolText(client, 'graphql_query', {
      query: `{ grp0 { get_res_0 { id } } grp2 { get_res_29 { id } } }`,
    }),
  )
  assert.deepEqual(result.errors, undefined)
  assert.equal(result.data.grp0.get_res_0.id, 'r0')
  assert.equal(result.data.grp2.get_res_29.id, 'r29')

  await client.close()
  await transport.close()
})

test('progressive: nested domain fragment re-wraps the real group types', async () => {
  // The example app carries tag 'catalog:tree' — force progressive over it.
  // Mount at its own path: createApp()'s bridge already occupies /mcp.
  const fresh = await createApp()
  const bridge = new HonoGqlMcp(fresh.app, {
    name: 'nested-domains',
    allowMutation: true,
    mode: 'progressive',
  })
  bridge.mountTo(fresh.app, '/mcp-prog')
  const { client, transport } = await mcpClient(AUTH, fresh.app, '/mcp-prog')

  const domains = envelope(await callToolText(client, 'list_domains', {}))
  const catalog = domains.data.domains.find((d: any) => d.name === 'catalog')
  assert.deepEqual(catalog.subdomains, ['tree'])

  const frag = envelope(await callToolText(client, 'get_query_schema', { domain: 'catalog:tree' }))
  const sdl: string = frag.data.sdl
  assert.ok(sdl.includes('catalog: CatalogQuery!'), sdl)
  assert.ok(sdl.includes('tree: CatalogTreeQuery!'))
  assert.ok(sdl.includes('categories'))
  assert.ok(sdl.includes('type Category'), 'reachable types are collected')
  assert.ok(!sdl.includes('list_notes'), 'sibling domains stay out')

  await client.close()
  await transport.close()
})

// -- readiness + construction-time errors ---------------------------------------------

test('readiness: the audit matches the startup notices (degraded → not ready)', () => {
  const report = handler.readiness()
  assert.equal(report.ready, false, 'the example app degrades Stats.by_tag to JSON')
  assert.equal(report.skips.length, 0)
  assert.ok(report.degradedFields.some(([where]) => where.includes('by_tag')))

  const clean = new RouterGraphQLHandler(bigApp())
  assert.equal(clean.readiness().ready, true)
})

test('DuplicateFieldError fires at construction, not at first query', () => {
  const app = new OpenAPIHono()
  const V = z.object({ v: z.string() })
  for (const path of ['/one', '/two']) {
    app.openapi(
      {
        method: 'get',
        path,
        tags: ['dup'],
        operationId: 'same_name',
        responses: { 200: okResponse(V) },
      } as Parameters<typeof createRoute>[0],
      (c) => c.json({ v: path }, 200),
    )
  }
  assert.throws(() => new RouterGraphQLHandler(app), /DuplicateFieldError/)
})

test('config: invalid mode throws HonoGqlMcpConfigError', async () => {
  const { app } = await createApp()
  assert.throws(
    () => new HonoGqlMcp(app, { mode: 'bogus' as never }),
    (e: unknown) => e instanceof Error && e.name === 'HonoGqlMcpConfigError',
  )
})

// -- plain GraphQL HTTP face + GraphiQL ----------------------------------------------

test('graphql face: POST executes with caller credentials, GET answers 405 usage', async () => {
  const fresh = await createApp() // createApp mounts /graphql + /graphiql itself

  const res = await fresh.app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ query: '{ notes { list_notes { title } } }' }),
  })
  assert.equal(res.status, 200)
  assert.ok(JSON.stringify(await res.json()).includes('Buy milk'))

  const unauthorized = await fresh.app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '{ notes { list_notes { title } } }' }),
  })
  // Partial failure keeps data present (nulls + errors) → 200, Python parity:
  // 400 is reserved for whole-document failure.
  assert.equal(unauthorized.status, 200)
  const body = await unauthorized.json()
  assert.ok(JSON.stringify(body).includes('HTTP_401'))
  assert.equal(body.data.notes.list_notes, null)

  const usage = await fresh.app.request('/graphql')
  assert.equal(usage.status, 405)
  assert.equal((await usage.json()).usage.method, 'POST')

  const html = await fresh.app.request('/graphiql')
  assert.ok((await html.text()).includes('GraphiQL'))
})

test('graphql face: variables travel to execution (not just operationName)', async () => {
  const fresh = await createApp()
  const res = await fresh.app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({
      query: 'query Q($id: String!) { notes { get_note(id: $id) { title } } }',
      variables: { id: 'n1' },
    }),
  })
  // The regression: variables was dropped (hardcoded undefined), so every
  // parameterized document failed variable coercion with a 400.
  assert.equal(res.status, 200)
  const body = (await res.json()) as { data?: { notes?: { get_note?: { title?: string } } } }
  assert.equal(body.data?.notes?.get_note?.title, 'Buy milk')

  // A malformed variables value is its own 400, distinct from variable coercion.
  const bad = await fresh.app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...AUTH },
    body: JSON.stringify({ query: '{ notes { list_notes { id } } }', variables: 'oops' }),
  })
  assert.equal(bad.status, 400)
  assert.ok(((await bad.json()) as { errors: Array<{ message: string }> }).errors[0].message.includes('variables'))
})

test('graphql face: non-JSON content-type is refused with 415 (cross-site form POST cannot reach the executor)', async () => {
  const fresh = await createApp()
  // Hono's c.req.json() would happily JSON.parse a text/plain body; without
  // the check this is a CORS "simple request" — no preflight — that a
  // cross-site HTML form can fire with the caller's session cookie riding
  // `cookie` passthrough. 415 closes the path.
  const res = await fresh.app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
    body: JSON.stringify({ query: '{ notes { list_notes { id } } }' }),
  })
  assert.equal(res.status, 415)

  // charset parameters stay legal — the media type is what matters.
  const charset = await fresh.app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...AUTH },
    body: JSON.stringify({ query: '{ notes { list_notes { id } } }' }),
  })
  assert.equal(charset.status, 200)
})

test('graphiql: pinned importmap, single shared React, fetcher wired to the endpoint', async () => {
  const fresh = await createApp()
  const html = await (await fresh.app.request('/graphiql')).text()

  // The importmap must be valid JSON — a malformed one fails silently in the
  // browser, leaving the loading placeholder up forever.
  const raw = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)?.[1]
  assert.ok(raw, 'importmap script present')
  const { imports } = JSON.parse(raw) as { imports: Record<string, string> }

  // Every entry is version-pinned. esm.sh resolves an unversioned specifier to
  // `latest`, so an unpinned entry lets the playground change under us.
  for (const [name, url] of Object.entries(imports)) {
    if (url.startsWith('data:')) continue
    assert.match(url, /(?:@\d+\.\d+\.\d+|@\d+\/)/, `importmap entry '${name}' is unpinned: ${url}`)
  }
  assert.match(imports['graphiql'], /^https:\/\/esm\.sh\/graphiql@/)
  assert.match(imports['react'], /^https:\/\/esm\.sh\/react@/)

  // `external=` keeps one React instance across every bundle — without it the
  // GraphiQL hooks and the Explorer plugin each load their own copy.
  assert.ok(imports['graphiql'].includes('external=react,react-dom,@graphiql/react,graphql'))
  assert.ok(imports['@graphiql/plugin-explorer'].includes('external=react,@graphiql/react,graphql'))

  // The page configures the fetcher for the mounted path, not a hardcoded one.
  assert.ok(html.includes("url: \"/graphql\""), 'fetcher points at the mount path')
  assert.ok(html.includes("credentials: 'same-origin'"), 'session cookie rides along')
  assert.ok(html.includes('explorerPlugin'), 'Explorer plugin wired')
  assert.ok(!html.includes('${'), 'no unsubstituted template placeholder leaked into the page')

  // A custom mount path flows into the page as a JS-safe literal.
  const custom = new OpenAPIHono()
  const bridge = new HonoGqlMcp(custom, { name: 'custom-graphql' })
  bridge.mountGraphQL(custom, { graphqlPath: '/api/gql', graphiqlPath: '/play' })
  const customHtml = await (await custom.request('/play')).text()
  assert.ok(customHtml.includes('url: "/api/gql"'), 'custom graphqlPath reaches the fetcher')
})

// -- REST docs: OpenAPI document + Swagger UI ------------------------------------------

test('docs: /openapi.json derives from the same createRoute definitions, recursion ref-safe', async () => {
  const fresh = await createApp()
  const res = await fresh.app.request('/openapi.json')
  assert.equal(res.status, 200)
  const doc = (await res.json()) as {
    openapi: string
    paths: Record<string, unknown>
    components?: { schemas?: Record<string, unknown> }
  }
  assert.ok(doc.openapi.startsWith('3.1'), doc.openapi)
  // Every zod-openapi route appears — a subset would mean the doc silently dropped routes.
  assert.deepEqual(
    Object.keys(doc.paths).sort(),
    ['/categories', '/notes', '/notes/{id}', '/stats'],
  )
  // The recursive Category schema is emitted as a $ref, not inlined forever —
  // the bug that made getOpenAPIDocument() blow the stack before `id` was set.
  const cat = JSON.stringify(doc.components?.schemas?.Category)
  assert.ok(cat.includes('"$ref":"#/components/schemas/Category"'), cat)

  // Swagger UI is mounted and points at the document.
  const ui = await fresh.app.request('/docs')
  assert.equal(ui.status, 200)
  const html = await ui.text()
  assert.ok(html.includes('swagger-ui'), 'swagger assets')
  assert.ok(html.includes('/openapi.json'), 'document url wired')
})

test('docs: /docs and /openapi.json are public; business routes stay gated', async () => {
  const fresh = await createApp()
  assert.equal((await fresh.app.request('/openapi.json')).status, 200)
  assert.equal((await fresh.app.request('/docs')).status, 200)
  assert.equal((await fresh.app.request('/notes')).status, 401, 'still gated')
})

// -- response limiting + rate limiting + run() -----------------------------------------

test('maxResponseChars truncates oversized tool results with a marker', async () => {
  const fresh = await createApp()
  const capped = new HonoGqlMcp(fresh.app, { name: 'capped', allowMutation: true, maxResponseChars: 150 })
  capped.mountTo(fresh.app, '/mcp-capped')
  const { client, transport } = await mcpClient(AUTH, fresh.app, '/mcp-capped')

  const raw = await callToolText(client, 'graphql_query', {
    query: '{ notes { list_notes { id title tags } } }',
  })
  assert.ok(raw.includes('[truncated — tool result exceeded maxResponseChars'))
  assert.ok(raw.length < 400, `truncated text should stay small, got ${raw.length}`)

  await client.close()
  await transport.close()
})

test('rateLimit: rapid requests above the budget get 429', async () => {
  const fresh = await createApp()
  const limited = new HonoGqlMcp(fresh.app, { name: 'limited', rateLimit: { maxPerSecond: 2 } })
  limited.mountTo(fresh.app, '/mcp-limited')

  const post = () =>
    fresh.app.request(
      new Request('http://localhost:8100/mcp-limited', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          host: 'localhost:8100',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
        }),
      }),
    )
  assert.equal((await post()).status, 200)
  assert.equal((await post()).status, 200)
  const third = await post()
  assert.equal(third.status, 429)
})

test('run(): standalone MCP server on its own port', async () => {
  const fresh = await createApp()
  const runner = new HonoGqlMcp(fresh.app, { name: 'standalone' })
  const server = await runner.run({ port: 8199 })
  try {
    const res = await fetch('http://127.0.0.1:8199/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    })
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.ok(body.includes('"standalone"'))
  } finally {
    await server.close()
  }
})

// -- auth: the endpoint gate, scopes, discovery (Group 5) ----------------------------

const JSONRPC_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  host: 'localhost:8100',
}
const INIT_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0.0' } },
})
const postTo = (target: Hono<any, any, any>, path: string, headers: Record<string, string> = {}) =>
  target.request(
    new Request(`http://localhost:8100${path}`, {
      method: 'POST',
      headers: { ...JSONRPC_HEADERS, ...headers },
      body: INIT_BODY,
    }),
  )

test('auth gate: no/bad token → 401 with a WWW-Authenticate Bearer challenge', async () => {
  const fresh = await createApp() // the example /mcp is gated by better-auth's verifier
  const no = await postTo(fresh.app, '/mcp')
  assert.equal(no.status, 401)
  assert.ok(no.headers.get('www-authenticate')?.startsWith('Bearer'), 'challenge header')
  assert.ok(
    no.headers.get('www-authenticate')?.includes('resource_metadata='),
    'challenge carries the discovery pointer (RFC 9728)',
  )

  const bad = await postTo(fresh.app, '/mcp', { authorization: 'Bearer wrong' })
  assert.equal(bad.status, 401)
  assert.ok(bad.headers.get('www-authenticate')?.includes('invalid_token'))
})

test('auth gate: a real token passes both checks — one Bearer, endpoint and routes', async () => {
  const fresh = await createApp()
  const { client, transport } = await mcpClient(AUTH, fresh.app, '/mcp')
  const { tools } = await client.listTools()
  assert.equal(tools.length, 3)
  const raw = await callToolText(client, 'graphql_query', {
    query: `{ notes { list_notes { title } } }`,
  })
  assert.ok(JSON.parse(raw).data.notes.list_notes.length >= 1)
  await client.close()
  await transport.close()
})

test('isolation: one user never sees another user\'s notes', async () => {
  const fresh = await createApp()
  const alice = { authorization: `Bearer ${await signToken('user-alice')}` }
  const bob = { authorization: `Bearer ${await signToken('user-bob')}` }

  // Alice creates a note.
  const created = await fresh.app.request('/notes', {
    method: 'POST',
    headers: { ...alice, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'alice-secret', tags: [] }),
  })
  assert.equal(created.status, 201)
  const noteId = ((await created.json()) as { id: string }).id

  // Alice sees it; Bob does not — not in his list, and a direct fetch is 404.
  const aliceList = (await (await fresh.app.request('/notes', { headers: alice })).json()) as Array<{ id: string }>
  assert.ok(aliceList.some((n) => n.id === noteId))
  const bobList = (await (await fresh.app.request('/notes', { headers: bob })).json()) as Array<{ id: string }>
  assert.ok(!bobList.some((n) => n.id === noteId), 'bob must not see alice\'s note')
  const bobGet = await fresh.app.request(`/notes/${noteId}`, { headers: bob })
  assert.equal(bobGet.status, 404, 'someone else\'s note does not exist for you')
})

test('auth gate: independent of route auth — gate token ≠ route token → HTTP_401 field errors', async () => {
  const fresh = await createApp()
  const gated = new HonoGqlMcp(fresh.app, {
    name: 'independent-gate',
    auth: {
      verifyToken: (token) =>
        token === 'gate-token'
          ? { token, clientId: 'gate', scopes: [], expiresAt: Math.floor(Date.now() / 1000) + 3600 }
          : null,
    },
  })
  gated.mountTo(fresh.app, '/mcp-ind')
  const { client, transport } = await mcpClient({ authorization: 'Bearer gate-token' }, fresh.app, '/mcp-ind')

  const raw = await callToolText(client, 'graphql_query', { query: `{ notes { list_notes { id } } }` })
  const result = JSON.parse(raw)
  assert.ok(
    result.errors?.some((e: { message: string }) => e.message.startsWith('HTTP_401')),
    'the gate passed, but the routes refuse the gate token — two independent checks',
  )
  await client.close()
  await transport.close()
})

test('auth gate: verifyToken returning null refuses with 401', async () => {
  const fresh = await createApp()
  const gated = new HonoGqlMcp(fresh.app, { name: 'null-gate', auth: { verifyToken: () => null } })
  gated.mountTo(fresh.app, '/mcp-null')
  const res = await postTo(fresh.app, '/mcp-null', { authorization: 'Bearer anything' })
  assert.equal(res.status, 401)
  assert.ok(res.headers.get('www-authenticate')?.includes('invalid_token'))
})

test('auth gate: sharedSecret — exact token passes, near-misses refuse (constant-time compare)', async () => {
  const fresh = await createApp()
  const gated = new HonoGqlMcp(fresh.app, { name: 'secret-gate', auth: { sharedSecret: 's3cret-token-abcdef' } })
  gated.mountTo(fresh.app, '/mcp-secret')
  // Prefix, suffix, longer, shorter: every near-miss must refuse. (The
  // comparison is constant-time — a timing signal cannot be asserted in a
  // test, but these pin the equality semantics it must preserve.)
  for (const token of ['s3cret-token-abcde', 's3cret-token-abcdef0', 'x3cret-token-abcdef', '']) {
    const res = await postTo(fresh.app, '/mcp-secret', ...(token ? [{ authorization: `Bearer ${token}` }] : []))
    assert.equal(res.status, 401, `near-miss '${token}' must refuse`)
  }
  const ok = await postTo(fresh.app, '/mcp-secret', { authorization: 'Bearer s3cret-token-abcdef' })
  assert.equal(ok.status, 200)
})

test('auth gate: requiredScopes — missing scope → 403 with a scope hint', async () => {
  const fresh = await createApp()
  const authInfo = (scopes: string[]) => ({ token: 't', clientId: 'c', scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
  const gated = new HonoGqlMcp(fresh.app, {
    name: 'scope-gate',
    auth: {
      verifyToken: (token) => (token === 'no-scope' ? authInfo([]) : authInfo(['mcp'])),
      requiredScopes: ['mcp'],
    },
  })
  gated.mountTo(fresh.app, '/mcp-scope')

  const denied = await postTo(fresh.app, '/mcp-scope', { authorization: 'Bearer no-scope' })
  assert.equal(denied.status, 403)
  assert.ok(denied.headers.get('www-authenticate')?.includes('insufficient_scope'))
  assert.ok(denied.headers.get('www-authenticate')?.includes('scope="mcp"'))

  const allowed = await postTo(fresh.app, '/mcp-scope', { authorization: 'Bearer ok' })
  assert.equal(allowed.status, 200)
})

test('auth: per-tool scopes — graphql_mutation demands notes:write (pre-dispatch 403)', async () => {
  // A dedicated app WITHOUT route-level auth: the gate is the only verifier,
  // so reader/writer tokens exercise the scope machinery in isolation.
  const items: Array<{ id: string; title: string }> = [{ id: 'i1', title: 'seed' }]
  let next = 2
  const app = new OpenAPIHono()
  const Item = z.object({ id: z.string(), title: z.string() }).meta({ title: 'Item' })
  app.openapi(
    createRoute({
      method: 'get',
      path: '/items',
      tags: ['items'],
      operationId: 'list_items',
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.array(Item) } } } },
    }),
    (c) => c.json(items, 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/items',
      tags: ['items'],
      operationId: 'create_item',
      request: { body: { content: { 'application/json': { schema: z.object({ title: z.string() }) } } } },
      responses: { 201: { description: 'created', content: { 'application/json': { schema: Item } } } },
    }),
    (c) => {
      const item = { id: `i${next++}`, title: c.req.valid('json').title }
      items.push(item)
      return c.json(item, 201)
    },
  )

  const authInfo = (scopes: string[]) => ({ token: 't', clientId: 'c', scopes, expiresAt: Math.floor(Date.now() / 1000) + 3600 })
  const gated = new HonoGqlMcp(app, {
    name: 'tool-scopes',
    allowMutation: true,
    auth: {
      verifyToken: (token) =>
        token === 'writer-token' ? authInfo(['mcp', 'items:write']) : authInfo(['mcp']),
      toolScopes: { graphql_mutation: ['items:write'] },
    },
  })
  gated.mountTo(app, '/mcp-ts')

  // Reader: queries pass, the write tool is refused before dispatch.
  const reader = await mcpClient({ authorization: 'Bearer reader-token' }, app, '/mcp-ts')
  const read = await callToolText(reader.client, 'graphql_query', {
    query: `{ items { list_items { title } } }`,
  })
  assert.ok(JSON.parse(read).data.items.list_items.length >= 1)
  await assert.rejects(
    () =>
      reader.client.callTool({
        name: 'graphql_mutation',
        arguments: { query: `mutation { items { create_item(body: { title: "nope" }) { id } } }` },
      }),
    /403|insufficient/i,
  )
  await reader.client.close()
  await reader.transport.close()

  // Writer: the mutation runs and is visible.
  const writer = await mcpClient({ authorization: 'Bearer writer-token' }, app, '/mcp-ts')
  const created = JSON.parse(
    await callToolText(writer.client, 'graphql_mutation', {
      query: `mutation { items { create_item(body: { title: "scoped write" }) { title } } }`,
    }),
  )
  assert.equal(created.data.items.create_item.title, 'scoped write')
  await writer.client.close()
  await writer.transport.close()
})

test('auth: discovery — RFC 9728/8414 well-known routes, normal paths untouched', async () => {
  // A bare app, NOT createApp(): the example mounts its own
  // /.well-known/oauth-authorization-server, and Hono serves the first match.
  const app = new OpenAPIHono()
  app.get('/ping', (c) => c.json({ ok: true }))
  const gated = new HonoGqlMcp(app, {
    name: 'discovery',
    auth: {
      sharedSecret: 'demo-secret',
      resourceMetadataUrl: 'http://localhost:8100/.well-known/oauth-protected-resource/mcp-d',
      discovery: {
        resourceServerUrl: 'http://localhost:8100/mcp-d',
        authorizationServerMetadata: {
          issuer: 'https://idp.example.com',
          authorization_endpoint: 'https://idp.example.com/authorize',
          token_endpoint: 'https://idp.example.com/token',
        } as never,
        scopesSupported: ['mcp', 'notes:write'],
        resourceName: 'notes-api',
      },
    },
  })
  gated.mountTo(app, '/mcp-d')

  const prm = await app.request('/.well-known/oauth-protected-resource/mcp-d')
  assert.equal(prm.status, 200)
  const prmBody = (await prm.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] }
  assert.equal(prmBody.resource, 'http://localhost:8100/mcp-d')
  assert.deepEqual(prmBody.authorization_servers, ['https://idp.example.com'])
  assert.deepEqual(prmBody.scopes_supported, ['mcp', 'notes:write'])

  const as = await app.request('/.well-known/oauth-authorization-server')
  assert.equal(as.status, 200)
  assert.equal(((await as.json()) as { issuer: string }).issuer, 'https://idp.example.com')

  // The well-known middleware falls through — regular routes unaffected.
  const ping = await app.request('/ping')
  assert.equal(ping.status, 200)
})

test('auth: config errors — verifier sources are mutually exclusive and required', async () => {
  const { app } = await createApp()
  assert.throws(
    () => new HonoGqlMcp(app, { auth: {} }),
    (e: unknown) => e instanceof Error && e.name === 'HonoGqlMcpConfigError',
  )
  assert.throws(
    () =>
      new HonoGqlMcp(app, {
        auth: { verifyToken: () => null, sharedSecret: 'x' },
      }),
    (e: unknown) => e instanceof Error && /only one/.test(e.message),
  )
})

// -- host/origin validation on /mcp ----------------------------------------------

test('host validation: default is localhost-only — a real hostname is 403 until allowed', async () => {
  const fresh = await createApp()
  // Mount every bridge BEFORE the first request — Hono builds its route
  // matcher on first request and rejects later registrations.
  const gated = new HonoGqlMcp(fresh.app, {
    name: 'domain',
    hostValidation: { allowedHostnames: ['api.example.com'], allowedOrigins: ['claude.ai'] },
  })
  gated.mountTo(fresh.app, '/mcp-domain')
  const open = new HonoGqlMcp(fresh.app, { name: 'open-host', hostValidation: { allowedHostnames: [] } })
  open.mountTo(fresh.app, '/mcp-anyhost')

  const init = (host: string, origin: string | undefined, authorization?: string) =>
    fresh.app.request(
      new Request('http://localhost:8100/mcp', {
        method: 'POST',
        headers: {
          ...JSONRPC_HEADERS,
          host,
          ...(origin ? { origin } : {}),
          ...(authorization ? { authorization } : {}),
        },
        body: INIT_BODY,
      }),
    )
  // Default (no hostValidation): any non-localhost Host is refused — CLI MCP
  // clients send Host, so a domain deployment is dead until it opts in.
  assert.equal((await init('api.example.com', undefined)).status, 403)
  // localhost passes the host check (the auth gate then answers 200 with a
  // real token — host validation runs BEFORE the gate, so the 403s above
  // fired without one).
  assert.equal((await init('localhost:8100', undefined, AUTH.authorization)).status, 200)
  // Browsers send Origin too; same allowlist applies.
  assert.equal((await init('localhost:8100', 'https://claude.ai')).status, 403)

  // Opt-in: naming the hostname lets its CLI and browser clients through.
  const initOn = (path: string, host: string, origin?: string, authorization?: string) =>
    fresh.app.request(
      new Request(`http://localhost:8100${path}`, {
        method: 'POST',
        headers: { ...JSONRPC_HEADERS, host, ...(origin ? { origin } : {}), ...(authorization ? { authorization } : {}) },
        body: INIT_BODY,
      }),
    )
  assert.equal((await initOn('/mcp-domain', 'api.example.com', undefined, AUTH.authorization)).status, 200, 'CLI client: Host allowed')
  assert.equal(
    (await initOn('/mcp-domain', 'api.example.com', 'https://claude.ai', AUTH.authorization)).status, 200,
    'browser client: Origin allowed',
  )
  assert.equal((await initOn('/mcp-domain', 'localhost:8100')).status, 403, 'not in the allowlist anymore')
  // Empty arrays disable each half — an explicit escape hatch for hosts that
  // terminate TLS upstream and cannot vouch for Host/Origin at all.
  const anyHost = await fresh.app.request(
    new Request('http://localhost:8100/mcp-anyhost', {
      method: 'POST',
      headers: { ...JSONRPC_HEADERS, host: 'whatever.example' },
      body: INIT_BODY,
    }),
  )
  assert.equal(anyHost.status, 200)
})

test('host validation: a malformed allowlist fails at construction', async () => {
  const { app } = await createApp()
  assert.throws(
    () => new HonoGqlMcp(app, { hostValidation: { allowedHostnames: ['ok', ''] } }),
    (e: unknown) => e instanceof Error && e.name === 'HonoGqlMcpConfigError',
  )
  assert.throws(
    () => new HonoGqlMcp(app, { hostValidation: { allowedOrigins: 'claude.ai' as never } }),
    (e: unknown) => e instanceof Error && e.name === 'HonoGqlMcpConfigError',
  )
})

// -- OpenTelemetry: one waterfall per query ---------------------------------------

/** Lazily register a real tracer provider + AsyncHooks context manager + in-memory exporter (memoized — one per process). */
let otelExporter: { getFinishedSpans: () => Array<any> } | undefined
async function otelSetup(): Promise<{ exporter: { getFinishedSpans: () => Array<any> } }> {
  if (otelExporter) return { exporter: otelExporter }
  const api = await import('@opentelemetry/api')
  const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } = await import('@opentelemetry/sdk-trace-base')
  const { AsyncHooksContextManager } = await import('@opentelemetry/context-async-hooks')
  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] })
  api.trace.setGlobalTracerProvider(provider)
  api.context.setGlobalContextManager(new AsyncHooksContextManager().enable())
  otelExporter = exporter
  return { exporter }
}

// OTel JS 2.x spans carry the parent as a SpanContext object, not a parentSpanId field.
const parentSpanIdOf = (span: any): string | undefined => span?.parentSpanContext?.spanId

test('otel: tools/call → graphql.execute → route span, one waterfall', async () => {
  const { exporter } = await otelSetup()

  // The example mounts @hono/otel BEFORE its routes under HONO_GQL_MCP_OTEL=1
  // (Hono middleware registered after a handler does not wrap it).
  process.env.HONO_GQL_MCP_OTEL = '1'
  const fresh = await createApp()

  const { client, transport } = await mcpClient(AUTH, fresh.app)
  await callToolText(client, 'graphql_query', {
    query: `{ notes { list_notes { title } } }`,
  })
  await client.close()
  await transport.close()

  const spans = exporter.getFinishedSpans()
  const tool = spans.find((s) => s.name === 'tools/call graphql_query')
  const exec = spans.find((s) => s.name === 'graphql.execute')
  assert.ok(tool, `tool span missing in: ${spans.map((s) => s.name).join(', ')}`)
  assert.ok(exec, 'graphql.execute span missing')

  // graphql.execute nests under the tool span (AsyncHooks context).
  assert.equal(parentSpanIdOf(exec), tool.spanContext().spanId)
  // The route span (from @hono/otel) nests under graphql.execute via the
  // injected W3C traceparent — the whole waterfall in one trace.
  const routeChildren = spans.filter((s) => parentSpanIdOf(s) === exec.spanContext().spanId)
  assert.ok(routeChildren.length >= 1, `no route span under graphql.execute in: ${spans.map((s) => s.name).join(', ')}`)
  assert.equal(exec.spanContext().traceId, tool.spanContext().traceId)
  assert.equal(routeChildren[0].spanContext().traceId, tool.spanContext().traceId)
})

test('otel: envelope traceparent parents the tool span to the caller trace', async () => {
  const { exporter } = await otelSetup()
  const { withToolSpan } = await import('../src/otel.ts')

  // A foreign caller's trace context, as the 2026-07-28 envelope would carry it.
  const traceId = '0af7651916cd43dd8448eb211c80319c'
  const callerSpanId = 'b7ad6b7169203331'
  const result = await withToolSpan('probe_tool', { traceparent: `00-${traceId}-${callerSpanId}-01` }, async () => 42)
  assert.equal(result, 42)

  const span = exporter.getFinishedSpans().find((s) => s.name === 'tools/call probe_tool')
  assert.ok(span, 'probe span missing')
  assert.equal(span.spanContext().traceId, traceId, 'span joins the CALLER trace')
  assert.equal(parentSpanIdOf(span), callerSpanId, 'span parents to the caller span')
})

test('otel: route.timeout and route.queue surface as events on graphql.execute', async () => {
  const { exporter } = await otelSetup()

  const { app: timeoutApp } = slowApp()
  const timedOut = new RouterGraphQLHandler(timeoutApp, { requestTimeoutMs: 50 })
  await timedOut.execute(`{ bench { slow(ms: 300) { slept } } }`)
  const exec1 = exporter.getFinishedSpans().filter((s) => s.name === 'graphql.execute').pop()
  assert.ok(exec1?.events.some((e: { name: string }) => e.name === 'route.timeout'), JSON.stringify(exec1?.events))

  const { app: queueApp } = slowApp()
  const queued = new RouterGraphQLHandler(queueApp, { requestTimeoutMs: null, maxConcurrency: 1 })
  await queued.execute(`{ bench { a: slow(ms: 60) { slept } b: slow(ms: 60) { slept } } }`)
  const exec2 = exporter.getFinishedSpans().filter((s) => s.name === 'graphql.execute').pop()
  assert.ok(exec2?.events.some((e: { name: string }) => e.name === 'route.queue'), JSON.stringify(exec2?.events))
})

// Close the shared store when the run ends, so WAL is checkpointed and the
// sqlite file is left clean for the next `npm test`.
process.on('exit', () => store.close())

// -- bridgeValidator: the zValidator-style route source -----------------------------

test('zValidator style: derived into the schema, typed args, callable, side by side with zod-openapi', async () => {
  // createApp carries one bridgeValidator route (/notes/search) next to its
  // zod-openapi routes — no DuplicateFieldError proves the two sources merge.
  const sdl = handler.getSDL()
  assert.ok(sdl.includes('get_search'), 'derived field present')
  assert.ok(sdl.includes('"""Search text."""'), 'arg description flows')
  assert.ok(sdl.includes('limit: Int = 5'), 'coerce+default maps to Int with default')

  const result = await gql(`{ notes { get_search(q: "milk") { title } } }`)
  assert.equal(JSON.stringify(d(result).notes.get_search), JSON.stringify([{ title: 'Buy milk' }]))
})

test('zValidator style: no responseSchema → raw-JSON bucket with a notice, not a skip', async () => {
  const app2 = new OpenAPIHono()
  app2.use('*', async (c, next) => {
    if (c.req.header('authorization') !== 'Bearer demo-secret') return c.json({ error: 'unauthorized' }, 401)
    await next()
  })
  app2.get(
    '/ping',
    bridgeValidator('query', z.object({ name: z.string() }), { tags: ['misc'], summary: 'Ping.' }),
    (c) => c.json({ pong: c.req.valid('query').name }),
  )
  const h = new RouterGraphQLHandler(app2, { allowMutation: false })
  assert.ok(h.getSDL().includes('get_ping(name: String!): JSON'), 'untyped response degrades to JSON')
  assert.ok(
    h.degraded.some((r) => r.path === '/ping' && r.reason.includes('no typed 2xx')),
    JSON.stringify(h.degraded),
  )
  assert.equal(h.skips.length, 0, 'still callable — degradation, not a skip')
  const result = await h.execute(`{ misc { get_ping(name: "x") } }`, undefined, {
    headers: { authorization: 'Bearer demo-secret' },
  })
  assert.equal(JSON.stringify(d(result).misc.get_ping), JSON.stringify({ pong: 'x' }))
})

test('zValidator style: form target and wildcard paths are skipped; filters apply', () => {
  const app3 = new OpenAPIHono()
  app3.post('/upload', bridgeValidator('form', z.object({})), (c) => c.text('ok'))
  app3.get('/wild/*', bridgeValidator('query', z.object({})), (c) => c.text('ok'))
  app3.get(
    '/kept',
    bridgeValidator('query', z.object({}), { tags: ['keep'] }),
    (c) => c.text('ok'),
  )
  const h = new RouterGraphQLHandler(app3)
  // form/wildcard validator routes are dropped at the scanner (silently —
  // there is no RouteConfig to classify into the skip buckets).
  assert.ok(!h.getSDL().includes('upload'), 'form body silently dropped')
  assert.ok(!h.getSDL().includes('wild'), 'wildcard path silently dropped')
  assert.ok(h.getSDL().includes('get_kept'), 'normal validator route kept')

  const filtered = new RouterGraphQLHandler(app3, { includeTags: ['keep'] })
  assert.ok(filtered.getSDL().includes('get_kept'), 'tag filter matches validator routes')
  const excluded = new RouterGraphQLHandler(app3, { exclude: ['/kept'] })
  assert.ok(!excluded.getSDL().includes('get_kept'), 'path filter drops validator routes')
})

// -- additions on top of the remote suite: coverage the 2026-10-11 pass lacks ------

test('MCP: graphql_mutation refuses non-mutation documents, and nothing executes', async () => {
  const { client, transport } = await mcpClient(AUTH)
  const result = (await client.callTool({
    name: 'graphql_mutation',
    arguments: { query: `{ notes { list_notes { id } } }` },
  })) as { isError?: boolean; content: Array<{ type: string; text: string }> }
  assert.equal(result.isError, true)
  assert.ok(result.content[0].text.includes('only runs mutation documents'), result.content[0].text)
  await client.close()
  await transport.close()
})

test('sub-app mounting: app.route() routes derive and execute (registry path merge)', async () => {
  const sub = new OpenAPIHono()
  sub.openapi(
    {
      method: 'get',
      path: '/items',
      tags: ['shop'],
      operationId: 'list_items',
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    } as Parameters<typeof createRoute>[0],
    (c) => c.json({ v: 'sub' }, 200),
  )
  const host = new OpenAPIHono()
  host.openapi(
    {
      method: 'get',
      path: '/root',
      tags: ['root'],
      operationId: 'root_op',
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    } as Parameters<typeof createRoute>[0],
    (c) => c.json({ v: 'root' }, 200),
  )
  host.route('/api', sub)
  const h = new RouterGraphQLHandler(host)
  assert.ok(h.getSDL().includes('list_items'), 'sub-app route derived from the merged registry path')
  const result = await h.execute(`{ shop { list_items { v } } }`)
  assert.equal(d(result).shop.list_items.v, 'sub')
})

test('skips: multipart/form-data body routes are skipped as non-JSON', () => {
  const app = new OpenAPIHono()
  app.openapi(
    {
      method: 'post',
      path: '/upload',
      tags: ['misc'],
      operationId: 'upload',
      request: { body: { content: { 'multipart/form-data': { schema: z.object({}) } } } },
      responses: { 200: okResponse(z.object({ ok: z.boolean() })) },
    } as Parameters<typeof createRoute>[0],
    (c) => c.json({ ok: true }, 200),
  )
  const h = new RouterGraphQLHandler(app, { allowMutation: true })
  assert.ok(
    h.skips.some((s) => s.path === '/upload' && s.reason.includes('non-JSON request body')),
    JSON.stringify(h.skips),
  )
})

test('Boolean success: an explicit z.void() response bridges as true', async () => {
  const app = new OpenAPIHono()
  // A read route too — a Query type with zero fields is not a valid schema.
  app.openapi(
    {
      method: 'get',
      path: '/status',
      tags: ['misc'],
      operationId: 'status',
      responses: { 200: okResponse(z.object({ ok: z.boolean() })) },
    } as Parameters<typeof createRoute>[0],
    (c) => c.json({ ok: true }, 200),
  )
  app.openapi(
    createRoute({
      method: 'post',
      path: '/nothing',
      tags: ['misc'],
      operationId: 'do_nothing',
      request: {
        body: { content: { 'application/json': { schema: z.object({ force: z.boolean().default(false) }) } } },
      },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.void() } } } },
    }),
    (c) => c.json(null, 200),
  )
  const h = new RouterGraphQLHandler(app, { allowMutation: true })
  const result = await h.execute(`mutation { misc { do_nothing(body: {}) } }`)
  assert.equal(d(result).misc.do_nothing, true)
})

test('raw JSON bucket: a non-JSON 2xx body comes back as raw text', async () => {
  const app = new OpenAPIHono()
  app.get(
    '/rawtext',
    bridgeValidator('query', z.object({}), { tags: ['raw'] }), // no responseSchema → JSON bucket
    (c) => c.text('plain-body', 200),
  )
  const h = new RouterGraphQLHandler(app)
  const result = await h.execute(`{ raw { get_rawtext } }`)
  assert.equal(d(result).raw.get_rawtext, 'plain-body')
})

test('progressive: get_query_schema on a mutation-only domain answers DOMAIN_NOT_FOUND', async () => {
  const app = new OpenAPIHono()
  app.openapi(
    createRoute({
      method: 'post',
      path: '/flush',
      tags: ['writes'],
      operationId: 'flush',
      request: {
        body: { content: { 'application/json': { schema: z.object({ force: z.boolean().default(false) }) } } },
      },
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.boolean() } } } },
    }),
    (c) => c.json(true, 200),
  )
  const b = new HonoGqlMcp(app, { name: 'mut-only', allowMutation: true, mode: 'progressive' })
  b.mountTo(app, '/mcp')
  const { client, transport } = await mcpClient({}, app)

  const queries = envelope(await callToolText(client, 'list_queries', { domain: 'writes' }))
  assert.equal(queries.success, true)
  assert.deepEqual(queries.data.queries, [])

  const frag = envelope(await callToolText(client, 'get_query_schema', { domain: 'writes' }))
  assert.equal(frag.success, false)
  assert.equal(frag.error_type, 'DOMAIN_NOT_FOUND')
  assert.ok(frag.error.includes('no GraphQL operations'), frag.error)

  await client.close()
  await transport.close()
})

test('MCP: the graphql_mutation example is a real, executable document', async () => {
  // The example app has mutations whose first field carries a REQUIRED body
  // arg — the sample must include it with a minimal valid literal (empty
  // title passes the route's z.string()), never index keys like `0:`.
  const fresh = await createApp()
  const b = new HonoGqlMcp(fresh.app, { name: 'mutation-example-check', allowMutation: true })
  b.mountTo(fresh.app, '/mcp-mut-example')
  const { client, transport } = await mcpClient(AUTH, fresh.app, '/mcp-mut-example')
  const { tools } = await client.listTools()
  const described = tools.find((t) => t.name === 'graphql_mutation')?.inputSchema as
    | { properties?: { query?: { description?: string } } }
    | undefined
  const example = described?.properties?.query?.description?.match(/e\.g\. (.+)$/)?.[1]
  assert.ok(example, `no example in the description: ${described?.properties?.query?.description}`)
  assert.ok(!example.includes('0:'), `arg names must not be array indices: ${example}`)
  assert.ok(example.startsWith('mutation {'), example)
  assert.deepEqual(validate(b.handler.schema, parse(example)), [])
  // Runnable against this very app — and cleaned up right after.
  const result = JSON.parse(await callToolText(client, 'graphql_mutation', { query: example }))
  assert.equal(result.errors, undefined, JSON.stringify(result.errors))
  const created = result.data.notes.create_note
  const deleted = JSON.parse(
    await callToolText(client, 'graphql_mutation', {
      query: `mutation { notes { delete_note(id: "${created.id}") } }`,
    }),
  )
  assert.equal(deleted.errors, undefined)
  await client.close()
  await transport.close()
})

test('MCP: samples include REQUIRED arg literals (params), omit optionals (route defaults)', async () => {
  // list_notes' optional tag/limit must stay OUT (limit: 0 would 400 at the
  // route's min(1)); a required path param must appear with a literal.
  const app = new OpenAPIHono()
  app.openapi(
    createRoute({
      method: 'get',
      path: '/thing/{id}',
      tags: ['thing'],
      operationId: 'get_thing',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    }),
    (c) => c.json({ v: c.req.valid('param').id }, 200),
  )
  const h = new RouterGraphQLHandler(app)
  const { sampleDocument } = await import('../src/mcp-tools.ts')
  const sample = sampleDocument(h.schema, 'query')
  assert.ok(sample, 'sample built')
  assert.ok(sample!.includes('get_thing(id: "")'), sample!)
  assert.ok(!sample!.includes('0:'), 'no index-keyed args')
  // The example app's first query field has only optionals → bare sample.
  const exampleAppSample = sampleDocument(handler.schema, 'query')
  assert.ok(exampleAppSample!.includes('list_notes'), exampleAppSample!)
  assert.ok(!exampleAppSample!.includes('limit'), 'optional args stay out (defaults run)')
})

test('graphql face: GraphiQL can be disabled or pointed at a self-hosted mirror', async () => {
  const base = new OpenAPIHono()
  base.openapi(
    {
      method: 'get',
      path: '/ping',
      tags: ['ping'],
      operationId: 'ping',
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    } as Parameters<typeof createRoute>[0],
    (c) => c.json({ v: 'x' }, 200),
  )

  const off = new OpenAPIHono()
  new HonoGqlMcp(base, { name: 'gql-off' }).mountGraphQL(off, { graphiql: false })
  assert.equal((await off.request('/graphiql')).status, 404, 'route not registered')
  assert.equal((await off.request('/graphql')).status, 405, 'the API face stays')

  const mirrored = new OpenAPIHono()
  new HonoGqlMcp(base, { name: 'gql-mirror' }).mountGraphQL(mirrored, { cdnBase: 'https://cdn.internal/' })
  const html = await mirrored.request('/graphiql')
  assert.equal(html.status, 200)
  const body = await html.text()
  assert.ok(body.includes('https://cdn.internal/react@'), 'importmap points at the mirror')
  assert.ok(!body.includes('https://esm.sh/react@'), 'the default CDN is gone')
})


test('zValidator shadow: change the import only — bare, metadata, and hook+meta forms', async () => {
  const app = new OpenAPIHono()
  // form 1 — bare: the exact original call shape, derived with defaults.
  app.get('/bare', zValidator('query', z.object({})), (c) => c.json({ ok: true }))
  // form 2 — bridge metadata as the 3rd argument.
  app.get(
    '/meta',
    zValidator('query', z.object({ n: z.string() }), {
      tags: ['shadow'],
      summary: 'With metadata.',
      responseSchema: z.object({ got: z.string() }),
    }),
    (c) => c.json({ got: c.req.valid('query').n }, 200),
  )
  // form 3 — the original hook as 3rd + metadata as 4th; the hook must still run.
  let hookRan = false
  app.get(
    '/hooked',
    zValidator(
      'query',
      z.object({ n: z.string() }),
      (result) => {
        if (result.success) hookRan = true
      },
      { tags: ['shadow'], responseSchema: z.object({ got: z.string() }) },
    ),
    (c) => c.json({ got: c.req.valid('query').n }, 200),
  )
  const h = new RouterGraphQLHandler(app)
  assert.ok(h.getSDL().includes('get_bare'), 'bare form derived (defaults)')
  assert.ok(h.getSDL().includes('got: String'), 'metadata form is field-selectable')

  const meta = await h.execute(`{ shadow { get_meta(n: "x") { got } } }`)
  assert.equal(d(meta).shadow.get_meta.got, 'x')
  const hooked = await h.execute(`{ shadow { get_hooked(n: "y") { got } } }`)
  assert.equal(d(hooked).shadow.get_hooked.got, 'y')
  assert.ok(hookRan, 'the original hook still runs through the shadow')

  // Validation behavior is the original's: a bad query answers zod's 400.
  const bad = await h.execute(`{ shadow { get_hooked(n: "y") { got } } }`, undefined, {})
  void bad
  const badHttp = await app.request('/hooked?nope=1')
  assert.equal(badHttp.status, 400, 'missing required query key → zod 400, unchanged')
})

// -- runner ----------------------------------------------------------------------
let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`)
  }
}
console.log(failed === 0 ? `\nAll ${tests.length} checks passed.` : `\n${failed}/${tests.length} checks FAILED.`)
process.exit(failed === 0 ? 0 : 1)
