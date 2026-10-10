/**
 * Protected notes API — the domain the agent queries via GraphQL/MCP, the
 * port of app/notes_routes.py.
 *
 * No router-level tag: each route carries exactly one domain tag, so every
 * field has a single address in the GraphQL schema.
 *
 * Auth errors throw HTTPException (main.ts's onError shapes them as FastAPI's
 * `{detail}`), which keeps the zod-openapi handler types clean — the direct
 * analog of FastAPI raising HTTPException from a dependency.
 */
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { HTTPException } from 'hono/http-exception'
import { resolveUser, type SessionUser } from './credentials.ts'
import { createNote, NOTES, ownedNotes, type Note } from './store.ts'
import { NoteCreate, NoteOut, NoteSummary, StatsOut } from './models.ts'

/** FastAPI's require_user dependency — throws 401 or returns the identity. */
function requireUser(c: { req: { raw: Request } }): SessionUser {
  const user = resolveUser(c.req.raw)
  if (!user) throw new HTTPException(401, { message: 'login required (/auth/login)' })
  return user
}

/** The caller's note, or a 404 — Python's shared ownership guard. */
function ownNote(noteId: number, user: SessionUser): Note {
  const note = NOTES.get(noteId)
  if (note === undefined || note.owner !== user.login) {
    throw new HTTPException(404, { message: 'note not found' })
  }
  return note
}

const asNoteOut = (n: Note) => ({ id: n.id, title: n.title, body: n.body, owner: n.owner })
const statsJson = () => {
  const owners = new Set([...NOTES.values()].map((n) => n.owner))
  return { notes: NOTES.size, users: owners.size }
}

export function registerNotesRoutes(app: OpenAPIHono<any>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/notes',
      tags: ['notes:mine'],
      summary: 'List YOUR notes (login required).',
      description: 'q filters by substring over title and body.',
      operationId: 'list_notes',
      request: { query: z.object({ q: z.string().optional().describe('substring over title/body') }) },
      responses: {
        200: { description: 'Your notes.', content: { 'application/json': { schema: z.array(NoteOut) } } },
      },
    }),
    (c) => {
      const user = requireUser(c)
      const { q } = c.req.valid('query')
      let notes = ownedNotes(user.login)
      if (q) {
        const needle = q.toLowerCase()
        notes = notes.filter((n) => n.title.toLowerCase().includes(needle) || n.body.toLowerCase().includes(needle))
      }
      return c.json(notes.map(asNoteOut), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/notes/{note_id}',
      tags: ['notes:mine'],
      summary: 'Fetch one of YOUR notes by id (login required).',
      operationId: 'get_note',
      request: { params: z.object({ note_id: z.coerce.number().int().describe('note id') }) },
      responses: { 200: { description: 'The note.', content: { 'application/json': { schema: NoteOut } } } },
    }),
    (c) => {
      const user = requireUser(c)
      const note = ownNote(c.req.valid('param').note_id, user)
      return c.json(asNoteOut(note), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/notes',
      tags: ['notes:mine'],
      summary: 'Create a note owned by you (login required).',
      operationId: 'create_note',
      request: { body: { content: { 'application/json': { schema: NoteCreate } } } },
      responses: { 200: { description: 'The created note.', content: { 'application/json': { schema: NoteOut } } } },
    }),
    (c) => {
      const user = requireUser(c)
      const body = c.req.valid('json')
      return c.json(asNoteOut(createNote(user.login, body.title, body.body)), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/api/notes/{note_id}',
      tags: ['notes:mine'],
      summary: 'Delete one of YOUR notes (login required).',
      operationId: 'delete_note',
      request: { params: z.object({ note_id: z.coerce.number().int().describe('note id') }) },
      responses: { 200: { description: 'The deleted note.', content: { 'application/json': { schema: NoteOut } } } },
    }),
    (c) => {
      const user = requireUser(c)
      const note = ownNote(c.req.valid('param').note_id, user)
      NOTES.delete(note.id)
      return c.json(asNoteOut(note), 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/stats',
      tags: ['meta'],
      summary: 'Public counters — no login needed.',
      operationId: 'stats',
      responses: { 200: { description: 'Counters.', content: { 'application/json': { schema: StatsOut } } } },
    }),
    (c) => c.json(statsJson(), 200),
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/notes/{note_id}/summary',
      tags: ['notes:mine'],
      summary: 'Sparse summary of YOUR note.',
      description:
        'Optional-heavy view. The Python demo relies on response_model_exclude_unset to ' +
        'degrade this field to the raw JSON scalar; the zod mapper types optional fields ' +
        'natively, so here it stays field-selectable — a deliberate cross-implementation delta.',
      operationId: 'note_summary',
      request: { params: z.object({ note_id: z.coerce.number().int().describe('note id') }) },
      responses: { 200: { description: 'Summary.', content: { 'application/json': { schema: NoteSummary } } } },
    }),
    (c) => {
      const user = requireUser(c)
      const note = ownNote(c.req.valid('param').note_id, user)
      // Full shape (defaults filled): zod-openapi's TypedResponse pins the
      // output type — the sparse-keys trick is Python-side only.
      return c.json({ id: note.id, title: note.title, pinned: false, color: null }, 200)
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/legacy/stats',
      tags: ['meta'],
      summary: 'Old stats endpoint kept for bookmarks — how deprecation is bridged.',
      description:
        'OpenAPI deprecated: true becomes GraphQL-native @deprecated: hidden from default ' +
        'introspection, still executable. Use stats.',
      operationId: 'legacy_stats',
      deprecated: true,
      responses: { 200: { description: 'Counters.', content: { 'application/json': { schema: StatsOut } } } },
    }),
    (c) => c.json(statsJson(), 200),
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/notes/{note_id}/attach',
      tags: ['notes:mine'],
      summary: 'Attach a file to YOUR note — how multipart routes are handled.',
      description:
        'Multipart bodies have no MCP input channel (tool arguments are JSON), so the ' +
        'bridge skips this route with an explicit reason. The route keeps working over plain HTTP.',
      operationId: 'attach_file',
      request: {
        params: z.object({ note_id: z.coerce.number().int().describe('note id') }),
        body: {
          content: { 'multipart/form-data': { schema: z.object({ filename: z.string() }) } },
        },
      },
      responses: {
        200: {
          description: 'Stored.',
          content: {
            'application/json': { schema: z.object({ note_id: z.int(), filename: z.string(), size: z.int() }) },
          },
        },
      },
    }),
    async (c) => {
      const user = requireUser(c)
      const note = ownNote(c.req.valid('param').note_id, user)
      const form = await c.req.raw.formData()
      const blob = form.get('blob')
      return c.json(
        { note_id: note.id, filename: String(form.get('filename')), size: blob instanceof File ? blob.size : 0 },
        200,
      )
    },
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/overview',
      tags: ['meta'],
      summary: 'Runtime overview — deliberately dynamic, assembled at call time.',
      description:
        'A z.record declares "shape is dynamic", so the bridge passes it through as the ' +
        'JSON scalar instead of demanding a fixed type — the agent sees the live keys.',
      operationId: 'overview',
      responses: {
        200: {
          description: 'Overview.',
          content: { 'application/json': { schema: z.record(z.string(), z.unknown()) } },
        },
      },
    }),
    (c) =>
      c.json(
        {
          app: 'notes-oauth example',
          notes: {
            total: NOTES.size,
            owners: [...new Set([...NOTES.values()].map((n) => n.owner))].sort(),
          },
          now: new Date().toISOString(),
        },
        200,
      ),
  )
}
