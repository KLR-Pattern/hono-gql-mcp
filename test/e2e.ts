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
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Hono } from 'hono'
import { createApp } from '../example/app.ts'
import { bridgeValidator, DuplicateFieldError, HonoGqlMcp, RouterGraphQLHandler } from '../src/index.ts'
import { runAll, test } from './runner.ts'

const AUTH = { authorization: 'Bearer demo-secret' }

/** graphql-js types query data as a loose map — tests read it as any. */
const d = (r: { data?: unknown }): any => r.data

// -- shared fixtures ------------------------------------------------------------
const { app, bridge } = createApp()
const handler = bridge.handler
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
  const { client, transport } = await mcpClient({}) // no credentials
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
  const created = JSON.parse(
    await callToolText(client, 'graphql_mutation', {
      query: `mutation { notes { create_note(body: { title: "from MCP", tags: ["mcp"] }) { id title } } }`,
    }),
  )
  assert.equal(created.errors, undefined)
  assert.equal(created.data.notes.create_note.title, 'from MCP')

  const listed = JSON.parse(
    await callToolText(client, 'graphql_query', {
      query: `{ notes { list_notes(tag: "mcp") { title } } }`,
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

// -- passthrough -------------------------------------------------------------------

test('passthrough: whitelisted cookie header reaches the route; unlisted headers never do', async () => {
  const app = new OpenAPIHono()
  app.openapi(
    {
      method: 'get',
      path: '/who',
      tags: ['session'],
      operationId: 'who',
      responses: { 200: okResponse(z.object({ session: z.string(), agent: z.string() })) },
    } as Parameters<typeof createRoute>[0],
    (c) =>
      c.json(
        { session: c.req.header('cookie') ?? 'none', agent: c.req.header('user-agent') ?? 'none' },
        200,
      ),
  )
  const h = new RouterGraphQLHandler(app, { passthroughHeaders: ['cookie'] })
  const seen = await h.execute(`{ session { who { session agent } } }`, undefined, {
    headers: { cookie: 'sid=abc', 'user-agent': 'curl/8' },
  })
  assert.equal(d(seen).session.who.session, 'sid=abc', 'whitelisted cookie rides through')
  assert.equal(d(seen).session.who.agent, 'none', 'unlisted headers are dropped at the bridge')
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
  const limited = await handler.execute(deep, undefined, { headers: AUTH })
  assert.ok(limited.errors?.some((e) => e.message.includes('max_depth')), JSON.stringify(limited.errors))

  const unlimited = new RouterGraphQLHandler(app, { maxDepth: null, allowMutation: true })
  const ok = await unlimited.execute(deep, undefined, { headers: AUTH })
  assert.equal(ok.errors, undefined)
})

test('hardening: document cache caches the front half — execution stays live', async () => {
  const h = new RouterGraphQLHandler(app, { allowMutation: true })
  const q = `{ notes { list_notes { id title } } }`
  const before = await h.execute(q, undefined, { headers: AUTH })
  await h.execute(
    `mutation { notes { create_note(body: { title: "cache-check" }) { id } } }`,
    undefined,
    { headers: AUTH },
  )
  const after = await h.execute(q, undefined, { headers: AUTH }) // same document — cache hit on parse/validate
  assert.equal(d(after).notes.list_notes.length, d(before).notes.list_notes.length + 1)
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

test('progressive: mode=auto switches above the threshold', () => {
  assert.equal(new HonoGqlMcp(bigApp()).resolvedMode, 'progressive')
  assert.equal(new HonoGqlMcp(bigApp(), { progressiveThreshold: 35 }).resolvedMode, 'simple')
  assert.equal(new HonoGqlMcp(bigApp(), { mode: 'simple' }).resolvedMode, 'simple')
  assert.equal(new HonoGqlMcp(createApp().app, { allowMutation: true, progressiveThreshold: 5 }).resolvedMode, 'progressive')
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
  const fresh = createApp()
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

  // list_mutations walks the write side of the same tree.
  const muts = envelope(await callToolText(client, 'list_mutations', { domain: 'notes' }))
  assert.equal(muts.success, true)
  const names = muts.data.mutations.map((m: any) => m.name)
  assert.ok(names.includes('create_note'), JSON.stringify(names))
  assert.ok(names.includes('delete_note'), JSON.stringify(names))
  const unknownMut = envelope(await callToolText(client, 'list_mutations', { domain: 'nope' }))
  assert.equal(unknownMut.error_type, 'DOMAIN_NOT_FOUND')

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
  assert.throws(() => new RouterGraphQLHandler(app), DuplicateFieldError)
})

test('config: invalid mode throws HonoGqlMcpConfigError', () => {
  assert.throws(
    () => new HonoGqlMcp(createApp().app, { mode: 'bogus' as never }),
    (e: unknown) => e instanceof Error && e.name === 'HonoGqlMcpConfigError',
  )
})

// -- plain GraphQL HTTP face + GraphiQL ----------------------------------------------

test('graphql face: POST executes with caller credentials, GET answers 405 usage', async () => {
  const fresh = createApp() // createApp mounts /graphql + /graphiql itself

  const res = await fresh.app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer demo-secret' },
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

// -- response limiting + rate limiting + run() -----------------------------------------

test('maxResponseChars truncates oversized tool results with a marker', async () => {
  const fresh = createApp()
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
  const fresh = createApp()
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
  const fresh = createApp()
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
  const fresh = createApp() // /mcp-secure is gated by sharedSecret = demo-secret
  const no = await postTo(fresh.app, '/mcp-secure')
  assert.equal(no.status, 401)
  assert.ok(no.headers.get('www-authenticate')?.startsWith('Bearer'), 'challenge header')

  const bad = await postTo(fresh.app, '/mcp-secure', { authorization: 'Bearer wrong' })
  assert.equal(bad.status, 401)
  assert.ok(bad.headers.get('www-authenticate')?.includes('invalid_token'))
})

test('auth gate: sharedSecret full MCP round trip — one token passes both checks', async () => {
  const fresh = createApp()
  const { client, transport } = await mcpClient(AUTH, fresh.app, '/mcp-secure')
  const { tools } = await client.listTools()
  assert.equal(tools.length, 3)
  const raw = await callToolText(client, 'graphql_query', {
    query: `{ notes { list_notes { title } } }`,
  })
  assert.ok(JSON.parse(raw).data.notes.list_notes.length >= 1)
  await client.close()
  await transport.close()
})

test('auth gate: independent of route auth — gate token ≠ route token → HTTP_401 field errors', async () => {
  const fresh = createApp()
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
  const fresh = createApp()
  const gated = new HonoGqlMcp(fresh.app, { name: 'null-gate', auth: { verifyToken: () => null } })
  gated.mountTo(fresh.app, '/mcp-null')
  const res = await postTo(fresh.app, '/mcp-null', { authorization: 'Bearer anything' })
  assert.equal(res.status, 401)
  assert.ok(res.headers.get('www-authenticate')?.includes('invalid_token'))
})

test('auth gate: requiredScopes — missing scope → 403 with a scope hint', async () => {
  const fresh = createApp()
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
  const fresh = createApp()
  const gated = new HonoGqlMcp(fresh.app, {
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
  gated.mountTo(fresh.app, '/mcp-d')

  const prm = await fresh.app.request('/.well-known/oauth-protected-resource/mcp-d')
  assert.equal(prm.status, 200)
  const prmBody = (await prm.json()) as { resource: string; authorization_servers: string[]; scopes_supported: string[] }
  assert.equal(prmBody.resource, 'http://localhost:8100/mcp-d')
  assert.deepEqual(prmBody.authorization_servers, ['https://idp.example.com'])
  assert.deepEqual(prmBody.scopes_supported, ['mcp', 'notes:write'])

  const as = await fresh.app.request('/.well-known/oauth-authorization-server')
  assert.equal(as.status, 200)
  assert.equal(((await as.json()) as { issuer: string }).issuer, 'https://idp.example.com')

  // The well-known middleware falls through — regular routes unaffected.
  const notes = await fresh.app.request('/notes', { headers: AUTH })
  assert.equal(notes.status, 200)
})

test('auth: config errors — verifier sources are mutually exclusive and required', () => {
  assert.throws(
    () => new HonoGqlMcp(createApp().app, { auth: {} }),
    (e: unknown) => e instanceof Error && e.name === 'HonoGqlMcpConfigError',
  )
  assert.throws(
    () =>
      new HonoGqlMcp(createApp().app, {
        auth: { verifyToken: () => null, sharedSecret: 'x' },
      }),
    (e: unknown) => e instanceof Error && /only one/.test(e.message),
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
  const fresh = createApp()

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

// -- runner ----------------------------------------------------------------------
await runAll('e2e')
