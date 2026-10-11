/**
 * Kitchen-sink anomaly battery — build the sink app, then interrogate the
 * bridge from every angle and print a findings report:
 *
 *  ① startup facts    — skips / degradations / renames, SDL validity
 *  ② every field      — a minimal executable document per derived field
 *  ③ REST parity      — same route over HTTP vs through GraphQL, data compared
 *  ④ suspicious edges — z.date() query args, hyphenated params, basePath,
 *                        recursion depth, cross-domain writes order
 *
 * Run: npm run smoke:sink
 */
import assert from 'node:assert/strict'
import { execute, GraphQLError, GraphQLList, GraphQLNonNull, GraphQLObjectType, parse, validate } from 'graphql'
import { createSinkApp } from './app.ts'

const findings: string[] = []
const note = (msg: string) => {
  findings.push(msg)
  console.log(`  ⚑ ${msg}`)
}

const { app, bridge } = createSinkApp()
const handler = bridge.handler
const schema = handler.schema

const line = (t: string) => console.log(`\n—— ${t} ${'—'.repeat(Math.max(0, 60 - t.length))}`)

// ---- ① startup facts -----------------------------------------------------------

line('① startup facts')
const report = handler.readiness()
console.log('  routes derived :', handler.routeCount)
console.log('  domains        :', handler.domains.join(', '))
console.log('  ready          :', report.ready)
for (const s of report.skips) console.log('  skip    :', s.method, s.path, '—', s.reason.slice(0, 80))
for (const d of report.degraded) console.log('  degrade:', d.method, d.path, '—', d.reason.slice(0, 80))
for (const [where, why] of report.degradedFields) console.log('  field   :', where, '—', why)
for (const [from, to] of report.renames) console.log('  rename  :', from, '—', to)

// SDL must parse back and accept an introspection document.
try {
  const sdl = handler.getSDL()
  const errors = validate(schema, parse(`{ __schema { types { name } } }`))
  if (errors.length) note(`introspection query fails against the built schema: ${errors[0].message}`)
  assert.ok(sdl.length > 0)
} catch (err) {
  note(`SDL/schema invalid: ${err instanceof Error ? err.message : err}`)
}

// ---- ② execute every derived field ---------------------------------------------

line('② every derived field gets a minimal document')

/** Minimal selection for a field's type: objects → first field (recursion-safe). */
function bareOf(type: unknown): unknown {
  let t = type
  while (t instanceof GraphQLNonNull || t instanceof GraphQLList) t = (t as { ofType: unknown }).ofType
  return t
}

function selectionFor(type: unknown, depth = 0, seen = new Set<string>()): string {
  const bare = bareOf(type)
  if (!(bare instanceof GraphQLObjectType)) return ''
  if (seen.has(bare.name)) return ' { __typename }'
  const next = new Set(seen).add(bare.name)
  const first = Object.values(bare.getFields())[0]
  return first ? ` { ${first.name}${selectionFor(first.type, depth + 1, next)} }` : ' { __typename }'
}

/** Serialize a literal in GraphQL syntax (enum values bare, object keys bare). */
function gqlLiteral(value: unknown): string {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const marked = value as { __enum?: string }
    if (marked.__enum) return marked.__enum
    return `{ ${Object.entries(value as Record<string, unknown>).filter(([k]) => k !== '__enum').map(([k, v]) => `${k}: ${gqlLiteral(v)}`).join(', ')} }`
  }
  return JSON.stringify(value)
}

/** A literal for an argument — NonNull input objects filled one level deep. */
function literalFor(type: unknown): unknown {
  const bare = bareOf(type)
  if (bare === null || bare === undefined) return null
  const name = String((bare as { name?: string }).name ?? '')
  if (name === 'Int' || name === 'Float') return 1
  if (name === 'Boolean') return true
  if (name === 'Date') return '2026-01-01T00:00:00.000Z'
  if (name === 'JSON' || name === 'String' || name === 'ID') return 'x'
  if (bare instanceof GraphQLObjectType) return {}
  const ctor = bare as { getValues?: () => Array<{ name: string }> }
  if (typeof ctor.getValues === 'function') return { __enum: ctor.getValues()[0]?.name ?? 'FIRST' }
  // Input object: fill required fields one level.
  const fields = (bare as { getFields?: () => Record<string, { type: unknown }> }).getFields?.() ?? {}
  const filled: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(fields)) {
    if (f.type instanceof GraphQLNonNull) filled[k] = literalFor(f.type)
  }
  return filled
}

const operation = async (kind: 'query' | 'mutation', owner: string[], name: string) => {
  // Walk the domain tree to the leaf field, then build a minimal document.
  let type: GraphQLObjectType = (kind === 'query' ? schema.getQueryType() : schema.getMutationType())!
  for (const seg of owner) {
    const field = type.getFields()[seg]
    const unwrapped = field.type instanceof GraphQLNonNull ? field.type.ofType : field.type
    type = unwrapped as GraphQLObjectType
  }
  const leaf = type.getFields()[name]
  if (!leaf) throw new Error(`field not found: ${owner.join(':')}|${name}`)
  const argSrc = (leaf.args ?? []).map((a) => `${a.name}: ${gqlLiteral(literalFor(a.type))}`)
  const inner = `${argSrc.length ? `(${argSrc.join(', ')})` : ''}${selectionFor(leaf.type)}`
  const parts = [...owner, name]
  const body = parts.reduceRight((acc, seg, i) => (i === parts.length - 1 ? `${seg}${inner}` : `${seg} { ${acc} }`), '')
  const text = `${kind} { ${body} }`
  try {
    return { errors: validate(schema, parse(text)), text }
  } catch (err) {
    return { errors: [err as GraphQLError], text }
  }
}

const executed: Array<{ kind: string; field: string; ok: boolean; error?: string }> = []
const allFields = [
  ...[...handler.queryFields.keys()].map((k) => ({ kind: 'query' as const, key: k })),
  ...[...handler.mutationFields.keys()].map((k) => ({ kind: 'mutation' as const, key: k })),
]
for (const { kind, key } of allFields) {
  const [ownerPath, name] = [key.split('|').slice(0, -1), key.split('|').pop()!]
  const owner = ownerPath.join(':').split(':').filter(Boolean)
  try {
    const { errors, text } = await operation(kind, owner, name)
    if (errors.length) {
      note(`${kind} ${key}: document fails — ${errors[0].message} (doc: ${text})`)
      continue
    }
    const result = await execute({ schema, document: parse(text) })
    const firstError = result.errors?.[0]?.message
    executed.push({ kind, field: key, ok: !result.errors, error: firstError })
    if (result.errors?.some((e) => e.message.startsWith('HTTP_400'))) {
      console.log(`  · ${kind} ${key} → 400 (placeholder literal rejected by the route's own zod — expected)`)
    } else if (result.errors) {
      note(`${kind} ${key} → UNEXPECTED field error: ${firstError?.slice(0, 110)}`)
    }
  } catch (err) {
    note(`${kind} ${key}: ${err instanceof Error ? err.message : err}`)
  }
}
console.log(`  executed ${executed.length} fields, ${executed.filter((e) => e.ok).length} clean, ${executed.filter((e) => !e.ok).length} with field errors`)

// ---- ③ REST parity ---------------------------------------------------------------

line('③ REST parity (same route, HTTP vs through GraphQL)')
const parityCases: Array<{ path: string; query: string }> = [
  { path: '/users?per_page=1', query: `{ users { list_users(per_page: 1) { id email } } }` },
  { path: '/users/11111111-1111-4111-8111-111111111111', query: `{ users { get_user(id: "11111111-1111-4111-8111-111111111111") { id email } } }` },
  { path: '/catalog/items', query: `{ shop { catalog { list_items { sku qty } } } }` },
  { path: '/misc/ping', query: `{ misc { ping } }` },
  { path: '/api/v1/status', query: `{ sub { sub_status { up } } }` },
]
/** True when every value in `sub` appears at the same path in `full` (GraphQL
 *  selects a subset of the REST body — equality would be the wrong oracle). */
function isSubset(sub: unknown, full: unknown): boolean {
  if (sub === null || sub === undefined) return true
  if (Array.isArray(sub)) {
    if (!Array.isArray(full) || full.length < sub.length) return false
    return sub.every((item, i) => isSubset(item, full[i]))
  }
  if (typeof sub === 'object') {
    if (typeof full !== 'object' || full === null) return false
    return Object.entries(sub).every(([k, v]) => k in full && isSubset(v, (full as Record<string, unknown>)[k]))
  }
  return sub === full
}

/** The innermost selection value, by walking the parsed document's field tree. */
function readAt(data: any, query: string): unknown {
  const doc = parse(query)
  const op = doc.definitions[0] as unknown as { selectionSet: { selections: Array<{ name: { value: string }, selectionSet?: { selections: unknown[] } }> } }
  const names: string[] = []
  let node: unknown = op.selectionSet.selections[0]
  while (node) {
    names.push((node as { name: { value: string } }).name.value)
    const inner = (node as { selectionSet?: { selections: unknown[] } }).selectionSet?.selections
    node = inner?.[0]
  }
  const at = (n: number): any => {
    let cur: any = data
    for (const seg of names.slice(0, n)) cur = cur?.[seg]
    return cur
  }
  // Object leaves compare at their own level (subset of the REST body);
  // scalar leaves one deeper (the REST body IS the scalar).
  return [at(names.length), at(names.length - 1)]
}

for (const { path, query } of parityCases) {
  const rest = await app.request(path)
  const restBody = await rest.json().catch(() => null)
  const gqlResult = await handler.execute(query)
  const gqlBodies = gqlResult.errors ? [] : (readAt(gqlResult.data as any, query) as unknown[])
  const same = gqlBodies.some((candidate) => isSubset(candidate, restBody))
  console.log(`  ${same ? '✓' : '✗'} ${path}${same ? '' : `\n      rest: ${JSON.stringify(restBody)?.slice(0, 140)}\n      gql : ${JSON.stringify(gqlBodies)} (${gqlResult.errors?.[0]?.message ?? ''})`}`)
  if (!same && !gqlResult.errors?.length) note(`REST/GraphQL data mismatch on ${path}`)
}

// ---- ④ suspicious edges -----------------------------------------------------------

line('④ suspicious edges')

// z.date() as a query arg — what actually arrives at the route?
{
  const probe = await app.request('/users/since?since=2026-01-01T00:00:00.000Z')
  console.log('  z.date() query over REST      :', probe.status)
  const gqlResult = await handler.execute(`{ users { users_since(since: "2026-01-01T00:00:00.000Z") { id } } }`)
  console.log('  z.date() query through bridge :', gqlResult.errors ? gqlResult.errors[0].message.slice(0, 100) : `${(gqlResult.data as any).users.users_since.length} rows`)
}

// Hyphenated path param — did the schema build, and does the field work?
{
  const sdlHasHyphen = handler.getSDL().includes('order-id')
  const field = handler.queryFields.get('misc|hyphen_param')
  if (sdlHasHyphen || field) {
    const result = await handler.execute(`{ misc { hyphen_param(order_id: "o1") { id } } }`).catch(() => null)
    const raw = await handler.execute(`{ misc { hyphen_param(order-id: "o1") { id } } }` as never).catch((e) => ({ errors: [{ message: String(e) }] }))
    console.log('  hyphen param field present    :', Boolean(field), '| legal-arg doc:', JSON.stringify(result?.errors?.[0]?.message?.slice(0, 60) ?? result?.data?.misc) , '| raw-arg doc:', JSON.stringify((raw as any)?.errors?.[0]?.message?.slice(0, 60)))
  } else {
    console.log('  hyphen param field            : not derived (not in queryFields, not in SDL)')
  }
}

// basePath(): same shape as app.route() but via a basePath'd Hono — does the
// registry know the prefix? (Constructed here; the sink app used app.route.)
{
  const { OpenAPIHono, createRoute, z } = await import('@hono/zod-openapi')
  const base = new OpenAPIHono().basePath('/v9')
  base.openapi(
    createRoute({
      method: 'get', path: '/things', tags: ['things'], operationId: 'list_things',
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ v: z.string() }) } } } },
    }),
    (c) => c.json({ v: 'x' }, 200),
  )
  const host = new OpenAPIHono()
  host.route('/', base)
  const paths = host.openAPIRegistry.definitions.filter((d) => d.type === 'route').map((d) => d.route.path)
  console.log('  basePath() registry paths     :', JSON.stringify(paths))
  try {
    const { RouterGraphQLHandler } = await import('../../src/index.ts')
    const h = new RouterGraphQLHandler(host)
    const result = await h.execute(`{ things { list_things { v } } }`)
    console.log('  basePath() through bridge     :', result.errors ? result.errors[0].message.slice(0, 80) : JSON.stringify((result.data as any).things.list_things))
    if (result.errors) note(`basePath()-mounted routes derive but do not execute: ${result.errors[0].message.slice(0, 80)}`)
  } catch (err) {
    note(`basePath() construction: ${err instanceof Error ? err.message.slice(0, 90) : err}`)
  }
}

// Recursion + maxDepth interplay: how deep can the caller go by default?
{
  const depth = (n: number) => `{ shop { catalog { category_tree { ${'children { name '.repeat(n)}name ${'} '.repeat(n)} } } } }`
  const ok = await handler.execute(depth(9).replace(/^/, 'query '))
  const deep = await handler.execute(depth(11).replace(/^/, 'query '))
  console.log('  recursion depth 9 (default)   :', ok.errors ? ok.errors[0].message.slice(0, 60) : 'ok')
  console.log('  recursion depth 11 (default)  :', deep.errors ? deep.errors[0].message.slice(0, 60) : 'ok')
}

// Writes in one document execute serially, in order — observe side effects.
{
  const before = [...handler.queryFields.keys()].length
  const order: string[] = []
  const result = await handler.execute(`mutation {
    users {
      create_user(body: { email: "serial@example.com" }) { id }
      create_user__2: create_user(body: { email: "serial2@example.com" }) { id }
    }
  }`)
  console.log('  two writes, one document      :', result.errors ? result.errors.map((e) => e.message.slice(0, 50)).join('; ') : 'both ran', `(field count stable: ${before === [...handler.queryFields.keys()].length})`)
  void order
}

// Aliases + fragments + variables in one document against the sink schema.
{
  const result = await handler.execute(
    `query Sink($email: String!) {
      a: users { list_users(q: $email) { ...UserBits } }
      b: users { list_users(per_page: 1) { id } }
    }
    fragment UserBits on User { id email }`,
    { email: 'ada' },
  )
  const a = (result.data as any)?.a?.list_users?.length
  const b = (result.data as any)?.b?.list_users?.length
  console.log('  aliases+fragments+variables   :', result.errors ? result.errors[0].message.slice(0, 80) : `ok (${a} + ${b} rows)`)
}

// ---- report -----------------------------------------------------------------------

line('findings')
if (findings.length === 0) console.log('  (none — everything behaved as documented)')
for (const f of findings) console.log('  ⚑', f)
console.log(findings.length === 0 ? '\nKITCHEN SINK OK' : `\nKITCHEN SINK: ${findings.length} finding(s)`)
process.exit(0)
