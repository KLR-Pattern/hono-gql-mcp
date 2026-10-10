/**
 * Demo app — a small notes service (notes / analytics / catalog domains,
 * bearer auth, one recursive type, one deliberately untyped field) with the
 * bridge mounted. Mirrors examples/shop of fastapi-gql-mcp.
 *
 *   npm run example        # REST + MCP /mcp on :8100
 *   npm test               # in-process end-to-end walkthrough
 */
import { serve } from '@hono/node-server'
import { pathToFileURL } from 'node:url'
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { HonoGqlMcp } from '../src/index.ts'

// ---- domain models — .meta({ title }) names the GraphQL type ----------------
const Note = z
  .object({
    id: z.string().describe('Note id.'),
    title: z.string().describe('Note title.'),
    tags: z.array(z.string()).describe('Free-form tags.'),
  })
  .meta({ title: 'Note', description: 'A note.' })

const NewNote = z
  .object({
    title: z.string().describe('Note title.'),
    tags: z.array(z.string()).default([]).describe('Free-form tags.'),
  })
  .meta({ title: 'NewNote', description: 'Payload for creating a note.' })

const Stats = z
  .object({
    total: z.int().describe('Total note count.'),
    by_tag: z.record(z.string(), z.int()).describe('Note count per tag (dynamic shape → JSON).'),
  })
  .meta({ title: 'Stats', description: 'Service statistics.' })

interface CategoryShape {
  name: string
  children: CategoryShape[]
}
const Category: z.ZodType<CategoryShape> = z
  .object({
    name: z.string(),
    children: z.array(z.lazy(() => Category)),
  })
  .meta({
    title: 'Category',
    description: 'A category tree node. Selecting children repeats your selection at every level.',
  })

// ---- routes -------------------------------------------------------------------
const TOKEN = 'demo-secret'

const listNotes = createRoute({
  method: 'get',
  path: '/notes',
  tags: ['notes'],
  operationId: 'list_notes',
  summary: 'Browse notes.',
  request: {
    query: z.object({
      tag: z.string().optional().describe('Filter by tag.'),
      limit: z.coerce.number().int().min(1).max(100).default(10).describe('Page size.'),
    }),
  },
  responses: {
    200: { description: 'Notes.', content: { 'application/json': { schema: z.array(Note) } } },
  },
})

const getNote = createRoute({
  method: 'get',
  path: '/notes/{id}',
  tags: ['notes'],
  operationId: 'get_note',
  summary: 'Fetch one note.',
  request: { params: z.object({ id: z.string().describe('Note id.') }) },
  responses: {
    200: { description: 'The note.', content: { 'application/json': { schema: Note } } },
    404: { description: 'No such note.' },
  },
})

const createNote = createRoute({
  method: 'post',
  path: '/notes',
  tags: ['notes'],
  operationId: 'create_note',
  summary: 'Create a note.',
  request: { body: { content: { 'application/json': { schema: NewNote } } } },
  responses: {
    201: { description: 'Created.', content: { 'application/json': { schema: Note } } },
  },
})

const deleteNote = createRoute({
  method: 'delete',
  path: '/notes/{id}',
  tags: ['notes'],
  operationId: 'delete_note',
  summary: 'Delete a note (204-style).',
  request: { params: z.object({ id: z.string() }) },
  responses: { 204: { description: 'Deleted.' } },
})

const stats = createRoute({
  method: 'get',
  path: '/stats',
  tags: ['analytics'],
  operationId: 'stats',
  summary: 'Service statistics.',
  responses: { 200: { description: 'Stats.', content: { 'application/json': { schema: Stats } } } },
})

const categories = createRoute({
  method: 'get',
  path: '/categories',
  tags: ['catalog:tree'],
  operationId: 'categories',
  summary: 'The recursive category tree.',
  responses: {
    200: { description: 'Tree.', content: { 'application/json': { schema: z.array(Category) } } },
  },
})

export function createApp() {
  const app = new OpenAPIHono()

  // ---- in-memory store (fresh per app instance) ------------------------------
  let nextId = 4
  const notes = new Map<string, { id: string; title: string; tags: string[] }>(
    [
      { id: 'n1', title: 'Buy milk', tags: ['errand'] },
      { id: 'n2', title: 'Ship 0.1.0', tags: ['work'] },
      { id: 'n3', title: 'Call mom', tags: ['family'] },
    ].map((n) => [n.id, n]),
  )
  const categoryTree: CategoryShape[] = [
    { name: 'docs', children: [{ name: 'guides', children: [{ name: 'quickstart', children: [] }] }] },
    { name: 'src', children: [{ name: 'core', children: [] }] },
  ]

  // The ONLY credential verifier — the bridge never holds tokens of its own.
  // The bridge's own endpoints (/mcp, /graphql, /graphiql) stay open (a
  // perimeter you control can gate them); business calls are verified
  // route-by-route via per-caller passthrough.
  app.use('*', async (c, next) => {
    const bridgeFace = /^\/(mcp|graphql|graphiql)/.test(c.req.path)
    if (!bridgeFace && c.req.header('authorization') !== `Bearer ${TOKEN}`) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
  })

  app.openapi(listNotes, (c) => {
    const { tag, limit } = c.req.valid('query')
    const all = [...notes.values()].filter((n) => !tag || n.tags.includes(tag))
    return c.json(all.slice(0, limit), 200)
  })
  app.openapi(getNote, (c) => {
    const { id } = c.req.valid('param')
    const note = notes.get(id)
    return note ? c.json(note, 200) : c.json({ error: 'not found' }, 404)
  })
  app.openapi(createNote, (c) => {
    const body = c.req.valid('json')
    const note = { id: `n${nextId++}`, ...body }
    notes.set(note.id, note)
    return c.json(note, 201)
  })
  app.openapi(deleteNote, (c) => {
    const { id } = c.req.valid('param')
    if (!notes.delete(id)) return c.json({ error: 'not found' }, 404)
    return c.body(null, 204)
  })
  app.openapi(stats, (c) => {
    const byTag: Record<string, number> = {}
    for (const n of notes.values()) for (const t of n.tags) byTag[t] = (byTag[t] ?? 0) + 1
    return c.json({ total: notes.size, by_tag: byTag }, 200)
  })
  app.openapi(categories, (c) => c.json(categoryTree, 200))

  const bridge = new HonoGqlMcp(app, {
    name: 'notes-api',
    allowMutation: true,
    instructions:
      'Notes service exposed as GraphQL (reads and writes). Domains: notes, analytics, catalog. ' +
      'Call get_schema once, then compose routes in a single graphql_query — a failing route nulls ' +
      'only its own field. Writes go through graphql_mutation.',
  })
  bridge.mountTo(app, '/mcp')
  bridge.mountGraphQL(app) // POST /graphql + GraphiQL at /graphiql
  return { app, bridge }
}

// ---- serve when run directly --------------------------------------------------
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const { app, bridge } = createApp()
  const port = Number(process.env.PORT ?? 8100)
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`notes-api demo`)
    console.log(`  REST     http://localhost:${info.port}/notes  (authorization: Bearer ${TOKEN})`)
    console.log(`  MCP      http://localhost:${info.port}/mcp`)
    console.log(`\nDerived GraphQL schema (${bridge.handler.domains.length} domains):\n`)
    console.log(bridge.handler.getSDL())
  })
}
