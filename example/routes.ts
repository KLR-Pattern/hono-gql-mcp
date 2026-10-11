/**
 * The notes service — REST routes in the zod-openapi style plus one
 * bridgeValidator route. The bridge derives the GraphQL schema and the MCP
 * tools from exactly these definitions.
 *
 * Every note route reads the caller off the context (`c.get('caller')`, set by
 * the auth middleware in app.ts) and passes that owner id straight to the
 * store, which scopes every query by it. Ownership lives in one place — the
 * store's WHERE clause — so someone else's note is a 404, never a 403: it does
 * not exist for you.
 */
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import { zValidator } from '../src/index.ts'
import type { Caller } from './auth.ts'
import type { CategoryShape, Store } from './store.ts'

// ---- domain models — .meta({ title }) names the GraphQL type ----------------
export const NoteSchema = z
  .object({
    id: z.string().describe('Note id.'),
    title: z.string().describe('Note title.'),
    tags: z.array(z.string()).describe('Free-form tags.'),
    owner: z.string().describe('Owning user id — always the caller: notes are per-user.'),
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
    total: z.int().describe('Your note count.'),
    by_tag: z.record(z.string(), z.int()).describe('Your note count per tag (dynamic shape → JSON).'),
  })
  .meta({ title: 'Stats', description: 'Per-caller statistics.' })

const Category: z.ZodType<CategoryShape> = z
  .object({
    name: z.string(),
    children: z.array(z.lazy(() => Category)),
  })
  .meta({
    // `id` registers the schema so recursive `children` becomes a $ref instead
    // of being inlined forever — without it the OpenAPI document build blows
    // the stack (see /openapi.json). `title` is the display name.
    id: 'Category',
    title: 'Category',
    description: 'A category tree node. Selecting children repeats your selection at every level.',
  })

/** Variables the auth middleware puts on the context. */
export interface Env {
  Variables: { caller: Caller | null }
}

/**
 * The caller on a business route. The auth middleware answers 401 before any
 * such route runs, so a handler that reaches here always has one — if it does
 * not, the middleware was not registered before these routes. Fail loudly with
 * that diagnosis instead of a TypeError on `undefined.id`.
 */
export function callerOf(c: Context<Env>): Caller {
  const caller = c.get('caller')
  if (!caller) throw new Error('no caller on the context — register the auth middleware before these routes')
  return caller
}

export function registerRoutes(app: OpenAPIHono<Env>, store: Store): void {
  const listNotes = createRoute({
    method: 'get',
    path: '/notes',
    tags: ['notes'],
    operationId: 'list_notes',
    summary: 'Browse your notes.',
    request: {
      query: z.object({
        tag: z.string().optional().describe('Filter by tag.'),
        limit: z.coerce.number().int().min(1).max(100).default(10).describe('Page size.'),
      }),
    },
    responses: {
      200: { description: 'Your notes.', content: { 'application/json': { schema: z.array(NoteSchema) } } },
    },
  })

  const getNote = createRoute({
    method: 'get',
    path: '/notes/{id}',
    tags: ['notes'],
    operationId: 'get_note',
    summary: 'Fetch one of your notes.',
    request: { params: z.object({ id: z.string().describe('Note id.') }) },
    responses: {
      200: { description: 'The note.', content: { 'application/json': { schema: NoteSchema } } },
      404: { description: 'No such note of yours.' },
    },
  })

  const createNote = createRoute({
    method: 'post',
    path: '/notes',
    tags: ['notes'],
    operationId: 'create_note',
    summary: 'Create a note you own.',
    request: { body: { content: { 'application/json': { schema: NewNote } } } },
    responses: {
      201: { description: 'Created.', content: { 'application/json': { schema: NoteSchema } } },
    },
  })

  const deleteNote = createRoute({
    method: 'delete',
    path: '/notes/{id}',
    tags: ['notes'],
    operationId: 'delete_note',
    summary: 'Delete one of your notes.',
    request: { params: z.object({ id: z.string() }) },
    responses: { 204: { description: 'Deleted.' }, 404: { description: 'No such note of yours.' } },
  })

  const stats = createRoute({
    method: 'get',
    path: '/stats',
    tags: ['analytics'],
    operationId: 'stats',
    summary: 'Your note statistics.',
    responses: { 200: { description: 'Stats.', content: { 'application/json': { schema: Stats } } } },
  })

  const categories = createRoute({
    method: 'get',
    path: '/categories',
    tags: ['catalog:tree'],
    operationId: 'categories',
    summary: 'The recursive category tree (public).',
    responses: {
      200: { description: 'Tree.', content: { 'application/json': { schema: z.array(Category) } } },
    },
  })

  app.openapi(listNotes, (c) => {
    const { tag, limit } = c.req.valid('query')
    return c.json(store.list(callerOf(c).id, { tag, limit }), 200)
  })
  app.openapi(getNote, (c) => {
    const { id } = c.req.valid('param')
    const note = store.find(id, callerOf(c).id)
    return note ? c.json(note, 200) : c.json({ error: 'not found' }, 404)
  })
  app.openapi(createNote, (c) => {
    const body = c.req.valid('json')
    return c.json(store.create({ title: body.title, tags: body.tags, owner: callerOf(c).id }), 201)
  })
  app.openapi(deleteNote, (c) => {
    const { id } = c.req.valid('param')
    if (!store.remove(id, callerOf(c).id)) return c.json({ error: 'not found' }, 404)
    return c.body(null, 204)
  })
  app.openapi(stats, (c) => c.json(store.stats(callerOf(c).id), 200))
  app.openapi(categories, (c) => c.json(store.categoryTree, 200))

  // The zValidator style — no createRoute, no registry: the wrapper exposes
  // the schema for bridge introspection (a plain zValidator's schema is
  // closure-private and cannot be derived).
  app.get(
    '/search',
    zValidator(
      'query',
      z.object({
        q: z.string().min(1).describe('Search text.'),
        limit: z.coerce.number().int().min(1).max(50).default(5).describe('Max hits.'),
      }),
      { tags: ['notes'], summary: 'Search your notes by title.', responseSchema: z.array(NoteSchema) },
    ),
    (c) => {
      const { q, limit } = c.req.valid('query')
      return c.json(store.search(callerOf(c).id, q, limit), 200)
    },
  )
}
