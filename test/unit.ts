/**
 * Unit-level checks — pure functions and construction-time classification,
 * each runnable independently of the e2e walkthrough:
 * fnmatch globs, documentDepth (incl. fragments), LruCache, domain grouping,
 * the Zod→GraphQL mapper (enum coverage the e2e app never exercises), and
 * option validation (hardening knobs + the header/cookie skip rule).
 */
import assert from 'node:assert/strict'
import { parse, printType, GraphQLEnumType, GraphQLNonNull } from 'graphql'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { fnmatchToRegExp } from '../src/fnmatch.ts'
import { documentDepth, RouterGraphQLHandler } from '../src/handler.ts'
import { LruCache, domainsFor } from '../src/index.ts'
import { ZodGraphqlMapper } from '../src/zod-to-graphql.ts'
import { runAll, test } from './runner.ts'

// -- fnmatch ----------------------------------------------------------------------

test('fnmatch: * crosses /, ? matches one char, patterns anchor both ends', () => {
  assert.ok(fnmatchToRegExp('/use*').test('/users'))
  assert.ok(fnmatchToRegExp('/use*').test('/users/123')) // * crosses /
  assert.ok(!fnmatchToRegExp('/use?').test('/users')) // ? is exactly one char
  assert.ok(fnmatchToRegExp('/use?').test('/user'))
  assert.ok(!fnmatchToRegExp('/users').test('/users/extra')) // anchored at the end
  assert.ok(fnmatchToRegExp('uers').test('uers'))
  assert.ok(!fnmatchToRegExp('uers').test('xuers')) // anchored at the start
})

test('fnmatch: [seq] and [!seq] character classes', () => {
  assert.ok(fnmatchToRegExp('/user[0-9]').test('/user5'))
  assert.ok(!fnmatchToRegExp('/user[0-9]').test('/usera'))
  assert.ok(fnmatchToRegExp('/user[!0-9]').test('/usera'))
  assert.ok(!fnmatchToRegExp('/user[!0-9]').test('/user5'))
  assert.ok(fnmatchToRegExp('/[ab]*').test('/a/b/c'))
})

test('fnmatch: regex metacharacters match literally; unterminated [ is literal', () => {
  assert.ok(fnmatchToRegExp('/a.b+c(d)').test('/a.b+c(d)'))
  assert.ok(!fnmatchToRegExp('/a.b').test('/axb'))
  assert.ok(fnmatchToRegExp('/a[').test('/a['))
  assert.ok(!fnmatchToRegExp('/a[').test('/ab'))
})

// -- documentDepth (fragment / inline-fragment / cycle branches) -------------------

test('documentDepth: plain nesting counts selection sets (root = 1)', () => {
  assert.equal(documentDepth(parse('{ a }')), 1)
  assert.equal(documentDepth(parse('{ a { b { c } } }')), 3)
})

test('documentDepth: inline fragments nest by one', () => {
  assert.equal(documentDepth(parse('{ a { ... on T { b { c } } } }')), 4)
})

test('documentDepth: fragment spreads nest by one', () => {
  // The spread itself costs a level: { a { ...F } } + F { b { c } } is one
  // deeper than the spread-free { a { b { c } } } (depth 3).
  const doc = parse('{ a { ...F } } fragment F on T { b { c } }')
  assert.equal(documentDepth(doc), 4)
})

test('documentDepth: fragment cycles terminate (each fragment counted once per path)', () => {
  const doc = parse('{ a { ...F } } fragment F on T { b { ...F } }')
  assert.equal(documentDepth(doc), 4) // F's own spread of itself is not re-entered
})

test('documentDepth: unused fragments do not count', () => {
  const doc = parse('{ a } fragment F on T { b { c { d { e } } } }')
  assert.equal(documentDepth(doc), 1)
})

// -- LruCache ----------------------------------------------------------------------

test('LruCache: recency refresh, capacity bound, 0 disables', () => {
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

// -- domain grouping -----------------------------------------------------------------

test('domainsFor: tags win, multi-tag multi-path, path fallback, general fallback', () => {
  assert.deepEqual(domainsFor(['shop:catalog'], '/x'), [['shop', 'catalog']])
  assert.deepEqual(domainsFor(['alpha', 'beta'], '/x'), [['alpha'], ['beta']])
  assert.deepEqual(domainsFor(undefined, '/users/123'), [['users']])
  assert.deepEqual(domainsFor(undefined, '/{id}/items'), [['items']])
  assert.deepEqual(domainsFor(undefined, '/{id}'), [['general']]) // all-param path
  assert.deepEqual(domainsFor(['camelCase-Tag'], '/x'), [['camel_case_tag']])
})

// -- ZodGraphqlMapper (enum paths the e2e app never exercises) ----------------------

test('mapper: z.enum → GraphQLEnumType on both sides, wire values preserved', () => {
  const mapper = new ZodGraphqlMapper()
  const out = mapper.outputType(z.enum(['fast', 'slow']), 'Speed')
  assert.ok(out instanceof GraphQLNonNull)
  const enumType = out.ofType
  assert.ok(enumType instanceof GraphQLEnumType)
  assert.equal(printType(enumType), 'enum Speed {\n  fast\n  slow\n}')

  const arg = mapper.inputArg(z.enum(['fast', 'slow']).optional(), 'Speed')
  // The input side maps the SAME schema again (input/output caches are
  // separate), so the enum's name collides with the output 'Speed' and gets
  // the reuse suffix — current behavior, documented here on purpose.
  assert.equal(String(arg.type), 'Speed_2')
})

test('mapper: enum member names must be legal GraphQL identifiers, else JSON', () => {
  const mapper = new ZodGraphqlMapper()
  const out = mapper.outputType(z.enum(['has space']), 'Bad')
  assert.equal(String(out), 'JSON!')
  assert.ok(
    mapper.degradations.some(([where, reason]) => where === 'Bad' && reason.includes('non-identifier')),
    JSON.stringify(mapper.degradations),
  )
})

test('mapper: reused type names get a suffix and a degradation record', () => {
  const mapper = new ZodGraphqlMapper()
  const A = mapper.outputType(z.object({ v: z.string() }), 'Thing')
  const B = mapper.outputType(z.object({ w: z.string() }), 'Thing')
  assert.equal(String(A), 'Thing!')
  assert.equal(String(B), 'Thing_2!')
  assert.ok(
    mapper.degradations.some(([where, reason]) => where === 'Thing (type name)' && reason.includes('Thing_2')),
    JSON.stringify(mapper.degradations),
  )
})

test('mapper: int detection reads both z.int() and z.number().int(); plain number → Float', () => {
  const mapper = new ZodGraphqlMapper()
  assert.equal(String(mapper.outputType(z.int(), 'N')), 'Int!')
  assert.equal(String(mapper.outputType(z.number().int(), 'N')), 'Int!')
  assert.equal(String(mapper.outputType(z.number(), 'N')), 'Float!')
  assert.equal(String(mapper.outputType(z.coerce.number().int(), 'N')), 'Int!')
})

test('mapper: dynamic shapes degrade to JSON with a recorded reason', () => {
  const mapper = new ZodGraphqlMapper()
  assert.equal(String(mapper.outputType(z.union([z.string(), z.number()]), 'U')), 'JSON!')
  assert.equal(String(mapper.outputType(z.literal('x'), 'L')), 'JSON!')
  assert.equal(String(mapper.outputType(z.any(), 'A')), 'JSON!')
  assert.ok(mapper.degradations.some(([where]) => where === 'U'))
  assert.ok(mapper.degradations.some(([where]) => where === 'L'))
})

test('mapper: date scalar round trip is ISO on the wire', () => {
  const mapper = new ZodGraphqlMapper()
  assert.equal(String(mapper.outputType(z.date(), 'D')), 'Date!')
})

// -- option validation -----------------------------------------------------------------

const minimalApp = () => {
  const app = new OpenAPIHono()
  app.openapi(
    createRoute({
      method: 'get',
      path: '/ping',
      operationId: 'ping',
      responses: { 200: { description: 'ok', content: { 'application/json': { schema: z.object({ v: z.string() }) } } } },
    }),
    (c) => c.json({ v: 'x' }, 200),
  )
  return app
}

test('config: hardening knobs reject values that would degrade silently', () => {
  const bad: Array<[string, object]> = [
    ['maxConcurrency: 0 (would deadlock behind a never-granted permit)', { maxConcurrency: 0 }],
    ['maxConcurrency: 1.5', { maxConcurrency: 1.5 }],
    ['requestTimeoutMs: 0 (would abort every call instantly)', { requestTimeoutMs: 0 }],
    ['requestTimeoutMs: -1', { requestTimeoutMs: -1 }],
    ['maxDepth: 0 (would reject every document)', { maxDepth: 0 }],
    ['documentCacheSize: -1', { documentCacheSize: -1 }],
  ]
  for (const [why, opts] of bad) {
    assert.throws(
      () => new RouterGraphQLHandler(minimalApp(), opts as never),
      (e: unknown) => e instanceof Error && e.name === 'HonoGqlMcpConfigError',
      why,
    )
  }
  // null (off) and legitimate edge values pass.
  new RouterGraphQLHandler(minimalApp(), { maxConcurrency: null, requestTimeoutMs: null, maxDepth: null })
  new RouterGraphQLHandler(minimalApp(), { documentCacheSize: 0, maxConcurrency: 1 })
})

// -- header/cookie skip rule (Python-bridge parity) ------------------------------------

const okResponse = (schema: z.ZodTypeAny) => ({
  description: 'ok',
  content: { 'application/json': { schema } },
})

test('skips: a required header/cookie parameter skips the route; optional stays callable', () => {
  const app = new OpenAPIHono()
  app.openapi(
    {
      method: 'get',
      path: '/hdr-required',
      operationId: 'hdr_required',
      request: { headers: z.object({ 'x-api-key': z.string() }) },
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    } as Parameters<typeof createRoute>[0],
    (c) => c.json({ v: 'x' }, 200),
  )
  app.openapi(
    {
      method: 'get',
      path: '/hdr-optional',
      operationId: 'hdr_optional',
      request: { headers: z.object({ 'x-trace': z.string().optional() }) },
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    } as Parameters<typeof createRoute>[0],
    (c) => c.json({ v: 'x' }, 200),
  )
  app.openapi(
    {
      method: 'get',
      path: '/cookie-required',
      operationId: 'cookie_required',
      request: { cookies: z.object({ session: z.string() }) },
      responses: { 200: okResponse(z.object({ v: z.string() })) },
    } as Parameters<typeof createRoute>[0],
    (c) => c.json({ v: 'x' }, 200),
  )
  const h = new RouterGraphQLHandler(app)
  assert.ok(
    h.skips.some((s) => s.path === '/hdr-required' && s.reason.includes("required header parameter 'x-api-key'")),
    JSON.stringify(h.skips),
  )
  assert.ok(
    h.skips.some((s) => s.path === '/cookie-required' && s.reason.includes('required cookie parameter')),
    JSON.stringify(h.skips),
  )
  const sdl = h.getSDL()
  assert.ok(!sdl.includes('hdr_required:'), 'required-header route must not derive a field')
  assert.ok(sdl.includes('hdr_optional:'), 'optional-header route stays callable')
})

// -- runner ------------------------------------------------------------------------
await runAll('unit')
