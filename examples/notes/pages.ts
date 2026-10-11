/**
 * The two HTML pages the OAuth server hands the browser: login and consent.
 * Both are plain strings — the demo has no view layer. Each one reads the
 * signed authorize query the server appended and posts it back.
 *
 *   login    POST /api/auth/sign-in/social { provider:'github', callbackURL }
 *            → { url }  →  browser goes to GitHub
 *   consent  POST /api/auth/oauth2/consent { accept, oauth_query }
 *            → { redirect_uri }  →  browser returns to the client with a code
 */

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const SHELL = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.6 system-ui, sans-serif; max-width: 34rem; margin: 4rem auto; padding: 0 1rem; color: #1f2328; }
  h1 { font-size: 1.4rem; }
  button { font: inherit; padding: .55rem 1.1rem; margin-right: .5rem; border: 1px solid #1f2328; border-radius: 6px; background: #1f2328; color: #fff; cursor: pointer; }
  button.secondary { background: #fff; color: #1f2328; }
  ul { padding-left: 1.2rem; }
  code { background: #f2f3f5; padding: .1rem .3rem; border-radius: 4px; }
  .muted { color: #59636e; font-size: .9rem; }
</style>
</head>
<body>
${body}
</body>
</html>`

/** Login page: offered when /oauth2/authorize finds no session. */
export function loginPageHtml(configured: boolean): string {
  if (!configured) {
    return SHELL(
      'Login',
      `<h1>GitHub not configured</h1>
       <p>Set <code>GITHUB_CLIENT_ID</code> and <code>GITHUB_CLIENT_SECRET</code> in <code>examples/notes/.env</code>, then restart.</p>
       <p class="muted">The REST and GraphQL surfaces still work; only login and the MCP OAuth gate need GitHub creds.</p>`,
    )
  }
  return SHELL(
    'Login',
    `<h1>Sign in</h1>
     <p>This MCP server authenticates with GitHub.</p>
     <button id="go">Continue with GitHub</button>
     <p class="muted" id="err"></p>
     <script>
       document.getElementById('go').addEventListener('click', async () => {
         // Arriving from /oauth2/authorize, the query is the signed authorize
         // request: return to it after login so the flow resumes. A direct
         // visit (no query) just lands on /.
         const q = window.location.search
         const callbackURL = q ? '/api/auth/oauth2/authorize' + q : '/'
         const res = await fetch('/api/auth/sign-in/social', {
           method: 'POST',
           headers: { 'content-type': 'application/json' },
           body: JSON.stringify({ provider: 'github', callbackURL }),
         })
         const data = await res.json().catch(() => ({}))
         if (data && data.url) window.location.href = data.url
         else document.getElementById('err').textContent = 'Sign-in failed: ' + JSON.stringify(data)
       })
     </script>`,
  )
}

/** Consent page: offered when the session exists and the client asked for consent. */
export function consentPageHtml(params: URLSearchParams): string {
  const clientId = params.get('client_id') ?? 'unknown client'
  const scopes = (params.get('scope') ?? '').split(/\s+/).filter(Boolean)
  const scopeList = scopes.length
    ? `<ul>${scopes.map((s) => `<li><code>${escapeHtml(s)}</code></li>`).join('')}</ul>`
    : '<p class="muted">No specific scopes requested.</p>'
  return SHELL(
    'Authorize',
    `<h1>Authorize access</h1>
     <p><strong>${escapeHtml(clientId)}</strong> is requesting access to this MCP server.</p>
     ${scopeList}
     <button id="accept">Allow</button>
     <button id="deny" class="secondary">Deny</button>
     <p class="muted" id="err"></p>
     <script>
       async function decide(accept) {
         const res = await fetch('/api/auth/oauth2/consent', {
           method: 'POST',
           headers: { 'content-type': 'application/json' },
           body: JSON.stringify({ accept, oauth_query: window.location.search.slice(1) }),
         })
         const data = await res.json().catch(() => ({}))
         // The endpoint's OpenAPI schema declares redirect_uri, but the
         // runtime payload is { redirect: true, url } — honor both.
         const target = (data && (data.url || data.redirect_uri)) || ''
         if (target) window.location.href = target
         else document.getElementById('err').textContent = 'Consent failed: ' + JSON.stringify(data)
       }
       document.getElementById('accept').addEventListener('click', () => decide(true))
       document.getElementById('deny').addEventListener('click', () => decide(false))
     </script>`,
  )
}

/** Landing page at / — links to the browser login and the API surfaces. */
export function landingPageHtml(baseUrl: string, configured: boolean): string {
  return SHELL(
    'hono-gql-mcp demo',
    `<h1>hono-gql-mcp — notes demo</h1>
     <p>REST and GraphQL over GitHub login; an agent reaches the same routes through MCP.</p>
     <ul>
       <li><a href="/auth/login">Login with GitHub</a> ${configured ? '' : '<span class="muted">(needs .env)</span>'}</li>
       <li><a href="/docs">REST docs</a> — Swagger UI over the same routes</li>
       <li><a href="/graphiql">GraphiQL</a> — your session cookie is forwarded automatically</li>
       <li><a href="${escapeHtml(baseUrl)}/mcp">MCP endpoint</a> <span class="muted">${configured ? '(OAuth 2.1)' : '(open — no GitHub creds)'}</span></li>
     </ul>
     <p class="muted">Data is per-user: you only see notes you created.</p>`,
  )
}
