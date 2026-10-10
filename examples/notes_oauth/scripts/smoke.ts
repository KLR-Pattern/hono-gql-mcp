/**
 * Full-flow smoke without GitHub credentials — the port of scripts/smoke.py.
 *
 * Mints a local session token and walks the protected path end to end:
 * /graphql without credentials (401-nulled field) → with them (data) → MCP
 * over HTTP carrying them → mutation → cleanup. Unlike the Python smoke
 * (which skips the MCP leg when the OAuth proxy is on), this gate verifies
 * the same signed session string, so the MCP leg runs in BOTH modes.
 *
 * Run: node examples/notes_oauth/scripts/smoke.ts
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createApp } from '../app/main.ts'
import { encodeSession, SESSION_COOKIE } from '../app/session.ts'
import { oauthConfigured } from '../app/config.ts'

const TOKEN = encodeSession({ login: 'smoke-user', name: 'Smoke' })
const HEADERS = { cookie: `${SESSION_COOKIE}=${TOKEN}`, authorization: `Bearer ${TOKEN}` }
const NOTES_QUERY = '{ notes { mine { list_notes { id title owner } } } meta { stats { users } } }'

const { app } = createApp()

// ① no credentials: the protected field nulls with HTTP_401, public survives.
const bare = await app.request('/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ query: NOTES_QUERY }),
})
const bareBody = (await bare.json()) as { data: any; errors: Array<{ message: string }> }
if (bareBody.data.notes.mine.list_notes !== null) throw new Error('expected 401-nulled field')
if (!bareBody.errors[0].message.startsWith('HTTP_401')) throw new Error(bareBody.errors[0].message)
if (bareBody.data.meta.stats.users < 1) throw new Error('public field must survive')
console.log('① no credentials: notes field nulled by 401, public field intact ✓')

// ② with credentials: protected query succeeds (owner isolation → empty list).
const authed = await app.request('/graphql', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...HEADERS },
  body: JSON.stringify({ query: NOTES_QUERY }),
})
const authedBody = (await authed.json()) as { data: any }
if (JSON.stringify(authedBody.data.notes.mine.list_notes) !== '[]') {
  throw new Error('fresh user starts empty')
}
console.log('② with credentials: protected query succeeds (owner isolation → empty list) ✓')

// ③④⑤ MCP: graphql_query → create → delete, credentials riding the headers.
const transport = new StreamableHTTPClientTransport(new URL('http://localhost:8020/mcp'), {
  fetch: ((input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init)
    req.headers.set('host', 'localhost:8020')
    return app.request(req)
  }) as typeof fetch,
  requestInit: { headers: HEADERS },
})
const client = new Client({ name: 'smoke', version: '1.0.0' }, { capabilities: {} })
await client.connect(transport)

const text = async (name: string, args: Record<string, unknown>) => {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text: string }>
  }
  return result.content[0].text
}

const queried = JSON.parse(await text('graphql_query', { query: NOTES_QUERY }))
if (JSON.stringify(queried.data.notes.mine.list_notes) !== '[]') throw new Error('MCP query failed')
console.log('③ MCP (session credentials): graphql_query through the protected route ✓')

const created = JSON.parse(
  await text('graphql_mutation', {
    query: `mutation { notes { mine { create_note(body: { title: "from smoke", body: "via MCP" }) { id owner } } } }`,
  }),
)
const note = created.data.notes.mine.create_note
if (note.owner !== 'smoke-user') throw new Error(JSON.stringify(note))
console.log(`④ MCP mutation creates a note as the caller id=${note.id} ✓`)

const deleted = JSON.parse(
  await text('graphql_mutation', {
    query: `mutation { notes { mine { delete_note(note_id: ${note.id}) { id } } } }`,
  }),
)
if (deleted.data.notes.mine.delete_note.id !== note.id) throw new Error('delete failed')
console.log('⑤ MCP mutation deletes the caller\'s own note ✓')

await client.close()
await transport.close()
console.log(`\nSMOKE OK — full flow verified (${oauthConfigured() ? 'gate ON' : 'gate open'}, except the GitHub redirect)`)
