/**
 * Kitchen sink — deliberately broad sample coverage of Hono + zod-openapi
 * shapes, to stress every corner of the bridge: buckets, domain grouping,
 * arg mapping, response faces, and the odd-but-legal corners real apps hit.
 *
 * Each section names what it exercises. Run the smoke for the anomaly
 * battery: `npm run smoke:sink`.
 */
import { serve } from '@hono/node-server'
import { pathToFileURL } from 'node:url'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { zValidator, HonoGqlMcp } from '../../src/index.ts'

// ---- shared schemas -----------------------------------------------------------

const User = z
  .object({
    id: z.uuid().describe('Stable id.'),
    email: z.email().describe('Contact email.'),
    name: z.string().nullish().describe('Display name — absent when anonymous.'),
    roles: z.array(z.enum(['admin', 'member', 'viewer'])).describe('Assigned roles.'),
    address: z
      .object({
        street: z.string(),
        city: z.string(),
        zip: z.string().regex(/^\d{5,6}$/).describe('Postal code.'),
      })
      .nullish()
      .describe('Absent for users who opted out.'),
    lastLogin: z.date().describe('ISO instant of the last login.'),
  })
  .meta({ title: 'User', description: 'A registered user.' })

const CreateUser = z
  .object({
    email: z.email(),
    name: z.string().optional(),
    roles: z.array(z.enum(['admin', 'member', 'viewer'])).default(['viewer']),
  })
  .meta({ title: 'CreateUser' })

const PatchUser = z
  .object({
    name: z.string().optional(),
    roles: z.array(z.enum(['admin', 'member', 'viewer'])).optional(),
  })
  .meta({ title: 'PatchUser', description: 'Partial update — everything optional.' })

/** Same .meta title as Order.Item below → exercises the renames path. */
const Item = z.object({ sku: z.string(), qty: z.int() }).meta({ title: 'Item' })
const OrderItem = z.object({ sku: z.string(), qty: z.int() }).meta({ title: 'Item' })

const Roles = z.nativeEnum({ ADMIN: 'admin', MEMBER: 'member', VIEWER: 'viewer' } as const)

interface CategoryShape {
  name: string
  children: CategoryShape[]
}
const Category: z.ZodType<CategoryShape> = z.object({
  name: z.string(),
  children: z.array(z.lazy(() => Category)),
})

const json = (schema: z.ZodType) => ({
  description: 'ok',
  content: { 'application/json': { schema } },
})

// ---- the app -------------------------------------------------------------------

export function createSinkApp() {
  const app = new OpenAPIHono()

  let nextUserId = 4
  const users = new Map<string, any>([
    ['11111111-1111-4111-8111-111111111111', {
      id: '11111111-1111-4111-8111-111111111111', email: 'ada@example.com', name: 'Ada',
      roles: ['admin'], address: { street: '1 Main', city: 'Springfield', zip: '12345' },
      lastLogin: new Date('2026-10-01T10:00:00Z'),
    }],
    ['22222222-2222-4222-8222-222222222222', {
      id: '22222222-2222-4222-8222-222222222222', email: 'bo@example.com', name: null,
      roles: ['viewer'], lastLogin: new Date('2026-09-01T10:00:00Z'),
    }],
  ])
  const orders = new Map<string, any>()

  // == users domain: the common CRUD shape ==================================
  app.openapi(
    createRoute({
      method: 'get', path: '/users', tags: ['users'], operationId: 'list_users',
      summary: 'Browse users.',
      request: { query: z.object({
        q: z.string().optional().describe('Substring over name/email.'),
        page: z.coerce.number().int().min(1).default(1).describe('1-based page.'),
        per_page: z.coerce.number().int().min(1).max(100).default(20).describe('Page size.'),
        role: z.enum(['admin', 'member', 'viewer']).optional().describe('Exact role filter.'),
      }) },
      responses: { 200: json(z.array(User)) },
    }),
    (c) => {
      const { q, page, per_page, role } = c.req.valid('query')
      let rows = [...users.values()]
      if (q) rows = rows.filter((u) => `${u.name ?? ''}${u.email}`.toLowerCase().includes(q.toLowerCase()))
      if (role) rows = rows.filter((u) => u.roles.includes(role))
      return c.json(rows.slice((page - 1) * per_page, page * per_page), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get', path: '/users/{id}', tags: ['users'], operationId: 'get_user',
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 200: json(User), 404: { description: 'No such user.' } },
    }),
    (c) => {
      const user = users.get(c.req.valid('param').id)
      return user ? c.json(user, 200) : c.json({ detail: 'no such user' }, 404)
    },
  )

  app.openapi(
    createRoute({
      method: 'post', path: '/users', tags: ['users'], operationId: 'create_user',
      request: { body: { content: { 'application/json': { schema: CreateUser } } } },
      responses: { 201: json(User), 409: { description: 'Email taken.' } },
    }),
    (c) => {
      const body = c.req.valid('json')
      const id = `${String(nextUserId++).padStart(8, '3')}-3333-4333-8333-333333333333`.slice(0, 36)
      const user = { id, ...body, name: body.name ?? null, lastLogin: new Date() }
      users.set(id, user)
      return c.json(user, 201)
    },
  )

  app.openapi(
    createRoute({
      method: 'patch', path: '/users/{id}', tags: ['users'], operationId: 'patch_user',
      request: {
        params: z.object({ id: z.uuid() }),
        body: { content: { 'application/json': { schema: PatchUser } } },
      },
      responses: { 200: json(User), 404: { description: 'No such user.' } },
    }),
    (c) => {
      const user = users.get(c.req.valid('param').id)
      if (!user) return c.json({ detail: 'no such user' }, 404)
      Object.assign(user, c.req.valid('json'))
      return c.json(user, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete', path: '/users/{id}', tags: ['users'], operationId: 'delete_user',
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 204: { description: 'Deleted.' } },
    }),
    (c) => (users.delete(c.req.valid('param').id) ? c.body(null, 204) : c.json({ detail: 'gone' }, 404)),
  )

  // Required header param → the skip rule (Python parity).
  app.openapi(
    createRoute({
      method: 'get', path: '/users/me', tags: ['users'], operationId: 'me',
      request: { headers: z.object({ 'x-api-key': z.string() }) },
      responses: { 200: json(User) },
    }),
    (c) => c.json([...users.values()][0], 200),
  )

  // z.date() as a QUERY arg — serialized into the query string on execution.
  app.openapi(
    createRoute({
      method: 'get', path: '/users/since', tags: ['users'], operationId: 'users_since',
      request: { query: z.object({ since: z.date().describe('ISO instant cutoff.') }) },
      responses: { 200: json(z.array(User)) },
    }),
    (c) => {
      const { since } = c.req.valid('query')
      return c.json([...users.values()].filter((u) => u.lastLogin >= since), 200)
    },
  )

  // == shop domains: nested tags, recursion, unions, dates =================
  app.openapi(
    createRoute({
      method: 'get', path: '/catalog/tree', tags: ['shop:catalog'], operationId: 'category_tree',
      responses: { 200: json(z.array(Category)) },
    }),
    (c) => c.json([{ name: 'a', children: [{ name: 'b', children: [] }] }], 200),
  )

  app.openapi(
    createRoute({
      method: 'get', path: '/catalog/items', tags: ['shop:catalog'], operationId: 'list_items',
      responses: { 200: json(z.array(Item)) },
    }),
    (c) => c.json([{ sku: 'A1', qty: 2 }], 200),
  )

  // Same meta title 'Item' as above → rename expected (not a degradation).
  app.openapi(
    createRoute({
      method: 'get', path: '/orders/{id}/items', tags: ['shop:orders'], operationId: 'order_items',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(z.array(OrderItem)) },
    }),
    (c) => c.json(orders.get(c.req.valid('param').id)?.items ?? [], 200),
  )

  // Discriminated-union body + union response → both land in the JSON bucket.
  app.openapi(
    createRoute({
      method: 'post', path: '/orders', tags: ['shop:orders'], operationId: 'create_order',
      request: { body: { content: { 'application/json': { schema: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('card'), number: z.string(), cvc: z.string() }),
        z.object({ kind: z.literal('paypal'), email: z.email() }),
      ]) } } } },
      responses: { 201: json(z.union([z.object({ ok: z.boolean() }), z.object({ pending: z.boolean() })])) },
    }),
    (c) => {
      const body = c.req.valid('json')
      const id = `o${orders.size + 1}`
      orders.set(id, { items: [{ sku: 'A1', qty: 1 }], payment: body })
      return c.json('kind' in body && body.kind === 'paypal' ? { pending: true } : { ok: true }, 201)
    },
  )

  app.openapi(
    createRoute({
      method: 'get', path: '/orders/{id}', tags: ['shop:orders'], operationId: 'get_order',
      request: { params: z.object({ id: z.string() }) },
      responses: { 200: json(z.object({
        id: z.string(),
        placedAt: z.date().describe('Date scalar on the OUTPUT side.'),
        paid: z.boolean(),
      })) },
    }),
    (c) => c.json({ id: c.req.valid('param').id, placedAt: new Date('2026-10-01T00:00:00Z'), paid: true }, 200),
  )

  // == misc edges ==========================================================
  // Untagged → domain from the first path segment.
  app.openapi(
    createRoute({
      method: 'get', path: '/misc/ping', operationId: 'ping',
      responses: { 200: json(z.literal('pong')) },
    }),
    (c) => c.json('pong', 200),
  )

  app.openapi(
    createRoute({
      method: 'get', path: '/misc/void', tags: ['misc'], operationId: 'noop',
      responses: { 200: json(z.void()) },
    }),
    (c) => c.json(null, 200),
  )

  // Multi-tag → lands in BOTH domains.
  app.openapi(
    createRoute({
      method: 'get', path: '/shared/summary', tags: ['alpha', 'beta:deep'], operationId: 'shared_summary',
      responses: { 200: json(z.object({ n: z.int() })) },
    }),
    (c) => c.json({ n: 1 }, 200),
  )

  // Deprecated + hidden.
  app.openapi(
    createRoute({
      method: 'get', path: '/misc/legacy', tags: ['misc'], operationId: 'legacy_op', deprecated: true,
      responses: { 200: json(z.object({ v: z.int() })) },
    }),
    (c) => c.json({ v: 0 }, 200),
  )
  app.openapi(
    createRoute({
      method: 'get', path: '/misc/internal', tags: ['misc'], operationId: 'internal_op', hide: true,
      responses: { 200: json(z.object({ secret: z.string() })) },
    }),
    (c) => c.json({ secret: 'x' }, 200),
  )

  // Non-JSON 2xx body → raw-JSON bucket with raw text passthrough.
  app.openapi(
    createRoute({
      method: 'get', path: '/misc/export', tags: ['misc'], operationId: 'export_csv',
      responses: { 200: { description: 'CSV.' } },
    }),
    (c) => c.text('a,b\n1,2', 200),
  )

  // Multipart → skipped.
  app.openapi(
    createRoute({
      method: 'post', path: '/misc/upload', tags: ['misc'], operationId: 'upload',
      request: { body: { content: { 'multipart/form-data': { schema: z.object({}) } } } },
      responses: { 200: json(z.object({ size: z.int() })) },
    }),
    async (c) => c.json({ size: (await c.req.raw.formData()).get('blob') instanceof File ? 1 : 0 }, 200),
  )

  // Shapes the mapper has no native wheel for → JSON bucket or surprises.
  app.openapi(
    createRoute({
      method: 'get', path: '/misc/shapes', tags: ['misc'], operationId: 'shapes',
      responses: { 200: json(z.object({
        tuple: z.tuple([z.string(), z.int()]),
        pair: z.intersection(z.object({ a: z.string() }), z.object({ b: z.int() })),
        bag: z.record(z.string(), z.unknown()),
        native: Roles,
        branded: z.string().brand<'UserId'>(),
      })) },
    }),
    (c) => c.json({ tuple: ['x', 1], pair: { a: 'x', b: 1 }, bag: { any: true }, native: 'admin', branded: 'u1' }, 200),
  )

  // Deeply nested object output — 5 levels.
  const L5 = z.object({ leaf: z.string() })
  const L4 = z.object({ l5: L5 })
  const L3 = z.object({ l4: L4 })
  const L2 = z.object({ l3: L3 })
  app.openapi(
    createRoute({
      method: 'get', path: '/misc/deep', tags: ['misc'], operationId: 'deep',
      responses: { 200: json(z.object({ l2: L2 })) },
    }),
    (c) => c.json({ l2: { l3: { l4: { l5: { leaf: 'bottom' } } } } }, 200),
  )

  // Hyphenated path param — an ILLEGAL GraphQL arg name candidate.
  app.openapi(
    createRoute({
      method: 'get', path: '/misc/orders/{order-id}', tags: ['misc'], operationId: 'hyphen_param',
      request: { params: z.object({ 'order-id': z.string() }) },
      responses: { 200: json(z.object({ id: z.string() })) },
    }),
    (c) => c.json({ id: c.req.valid('param')['order-id'] }, 200),
  )

  // Same operationId in a DIFFERENT domain — legal, both should coexist.
  app.openapi(
    createRoute({
      method: 'get', path: '/audit/users', tags: ['audit'], operationId: 'list_users',
      responses: { 200: json(z.object({ count: z.int() })) },
    }),
    (c) => c.json({ count: users.size }, 200),
  )

  // The zValidator-style second source, beside everything above.
  app.get(
    '/misc/search',
    zValidator('query', z.object({ q: z.string().min(1).describe('Search text.') }), {
      tags: ['misc'], summary: 'Search — zValidator-style route.', responseSchema: z.array(z.object({ hit: z.string() })),
    }),
    (c) => c.json([{ hit: c.req.valid('query').q }], 200),
  )

  // Sub-app mounted via app.route(): registry paths merge with the prefix.
  const sub = new OpenAPIHono()
  sub.openapi(
    createRoute({
      method: 'get', path: '/status', tags: ['sub'], operationId: 'sub_status',
      responses: { 200: json(z.object({ up: z.boolean() })) },
    }),
    (c) => c.json({ up: true }, 200),
  )
  app.route('/api/v1', sub)

  const bridge = new HonoGqlMcp(app, { name: 'kitchen-sink', allowMutation: true })
  bridge.mountTo(app, '/mcp')
  bridge.mountGraphQL(app)
  return { app, bridge }
}

// ---- serve when run directly (the demo target — no auth, port 8110) -----------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { app } = createSinkApp()
  serve({ fetch: app.fetch, port: 8110 }, () => {
    console.log('kitchen-sink demo — http://localhost:8110  (MCP at /mcp, GraphQL at /graphql)')
  })
}
