/**
 * The plain-GraphQL HTTP face — a port of fastapi-gql-mcp's http_api.py.
 *
 * POST /graphql executes documents (`{query, variables?, operationName?}`);
 * GET /graphql answers 405 with usage; GET /graphiql serves the playground.
 * The endpoint shares the handler's passthrough whitelist with the MCP face
 * — incoming credentials travel to the routes under the same rules (the
 * executor applies the whitelist, so browser sessions ride `cookie` once it
 * is whitelisted).
 */
import type { Hono } from 'hono'
import type { RouterGraphQLHandler } from './handler.ts'

export interface GraphqlMountOptions {
  graphqlPath?: string
  graphiqlPath?: string
}

/**
 * Versions the playground pins. They are pinned deliberately: esm.sh resolves
 * an unversioned specifier to `latest`, so the page would change shape whenever
 * GraphiQL ships. They still must move together — graphiql@5.4.0 and
 * @graphiql/plugin-explorer@5.1.5 both peer-depend on @graphiql/react ^0.39.0,
 * which is where 0.39.1 lands.
 */
const GRAPHIQL_VERSIONS = {
  react: '19.1.0',
  graphiql: '5.4.0',
  graphiqlReact: '0.39.1',
  graphiqlExplorer: '5.1.5',
  graphiqlToolkit: '0.12.1',
  // The browser talks to the schema through introspection, so its graphql-js
  // copy is independent of the server's (^17). 16 is what the pinned GraphiQL
  // build is tested against.
  graphql: '16.11.0',
} as const

/** A JS string literal safe to inline in the page — the URL is host-supplied. */
const jsString = (s: string): string => JSON.stringify(s)

/**
 * GraphiQL playground — the same ESM + importmap wiring as the Python bridge
 * (fastapi_gql_mcp/graphiql.py), so both faces behave identically. Loaded from
 * the esm.sh CDN: no build step, and the Explorer plugin comes along.
 *
 * `@graphiql/plugin-explorer` is what makes the "click a field to build the
 * query" affordance work — a visual query builder beside the editor. Plain
 * GraphiQL 3 (UMD `<script>`) had only the docs panel, whose click inserts at
 * the cursor; newer GraphiQL is ESM-only, so the UMD path cannot carry it.
 *
 * `?standalone` + `external=` make esm.sh serve ONE copy of react and
 * @graphiql/react, shared by every entry in the importmap — without them each
 * bundle inlines its own React and hooks fail across the boundary.
 */
function graphiqlHtml(graphqlPath: string): string {
  const v = GRAPHIQL_VERSIONS
  const url = jsString(graphqlPath)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GraphiQL — hono-gql-mcp</title>
  <style>
    body { margin: 0; }
    #graphiql { height: 100dvh; }
    .loading { height: 100%; display: flex; align-items: center; justify-content: center;
               font-size: 2rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
  </style>
  <link rel="stylesheet" href="https://esm.sh/graphiql@${v.graphiql}/dist/style.css" />
  <link rel="stylesheet" href="https://esm.sh/@graphiql/plugin-explorer@${v.graphiqlExplorer}/dist/style.css" />
  <script type="importmap">
    {
      "imports": {
        "react": "https://esm.sh/react@${v.react}",
        "react/jsx-runtime": "https://esm.sh/react@${v.react}/jsx-runtime",
        "react-dom": "https://esm.sh/react-dom@${v.react}",
        "react-dom/client": "https://esm.sh/react-dom@${v.react}/client",
        "@emotion/is-prop-valid": "data:text/javascript,",
        "graphiql": "https://esm.sh/graphiql@${v.graphiql}?standalone&external=react,react-dom,@graphiql/react,graphql",
        "graphiql/": "https://esm.sh/graphiql@${v.graphiql}/",
        "@graphiql/plugin-explorer": "https://esm.sh/@graphiql/plugin-explorer@${v.graphiqlExplorer}?standalone&external=react,@graphiql/react,graphql",
        "@graphiql/react": "https://esm.sh/@graphiql/react@${v.graphiqlReact}?standalone&external=react,react-dom,graphql,@emotion/is-prop-valid",
        "@graphiql/toolkit": "https://esm.sh/@graphiql/toolkit@${v.graphiqlToolkit}?standalone&external=graphql",
        "graphql": "https://esm.sh/graphql@${v.graphql}"
      }
    }
  </script>
</head>
<body>
  <div id="graphiql"><div class="loading">Loading GraphiQL…</div></div>
  <script>
    // Offline/intranet notice: everything above comes from the esm.sh CDN. When
    // it is unreachable the placeholder would hang forever — say so after 10s
    // and point at the raw endpoint (which never needed the CDN).
    window.setTimeout(function () {
      var el = document.querySelector('#graphiql .loading');
      if (el) el.textContent = 'GraphiQL failed to load — esm.sh CDN unreachable '
        + '(offline or restricted network?). The GraphQL API itself is fine: '
        + 'POST ${url} directly.';
    }, 10000);
  </script>
  <script type="module">
    import React from 'react';
    import ReactDOM from 'react-dom/client';
    import { GraphiQL } from 'graphiql';
    import { createGraphiQLFetcher } from '@graphiql/toolkit';
    import { explorerPlugin } from '@graphiql/plugin-explorer';

    // #graphiql already holds the loading placeholder — clear it before React
    // takes the container (createRoot warns on a non-empty root).
    const container = document.getElementById('graphiql');
    container.textContent = '';

    // The browser session reaches /graphql as a same-origin cookie, and the
    // passthrough whitelist forwards it on to the routes. The Fetch spec backs
    // this by default: Request.credentials is 'same-origin' when unset, so the
    // explicit value states the intent rather than changing behavior.
    const fetcher = createGraphiQLFetcher({
      url: ${url},
      fetch: (input, init) => fetch(input, { ...init, credentials: 'same-origin' })
    });

    function App() {
      return React.createElement(GraphiQL, {
        fetcher: fetcher,
        plugins: [explorerPlugin()]
      });
    }
    ReactDOM.createRoot(container).render(React.createElement(App));
  </script>
</body>
</html>`
}

export function mountGraphQL(
  app: Hono<any, any, any>,
  handler: RouterGraphQLHandler,
  opts: GraphqlMountOptions = {},
): void {
  const graphqlPath = opts.graphqlPath ?? '/graphql'
  const graphiqlPath = opts.graphiqlPath ?? '/graphiql'

  app.post(graphqlPath, async (c) => {
    // application/json only. Hono's c.req.json() JSON.parses any content-type,
    // so without this check a text/plain HTML-form POST is a CORS "simple
    // request" — no preflight — and a cross-site page could fire mutations
    // with the caller's session cookie (when `cookie` is whitelisted).
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
    if (contentType !== 'application/json') {
      return c.json(
        { errors: [{ message: `Content-Type must be application/json (got '${contentType || 'none'}').` }] },
        415,
      )
    }
    let body: { query?: unknown; variables?: unknown; operationName?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ errors: [{ message: 'Request body must be JSON.' }] }, 400)
    }
    if (typeof body.query !== 'string') {
      return c.json({ errors: [{ message: "Body must carry a string 'query'." }] }, 400)
    }
    // variables: a plain object of variable values, when the document declares any.
    if (body.variables !== undefined && (typeof body.variables !== 'object' || body.variables === null || Array.isArray(body.variables))) {
      return c.json({ errors: [{ message: "'variables' must be an object of variable values." }] }, 400)
    }
    const result = await handler.execute(body.query, body.variables as Record<string, unknown> | undefined, {
      // The executor applies the passthrough whitelist — raw headers are safe
      // to hand over; only whitelisted names ever reach a route.
      headers: c.req.raw.headers,
      ...(typeof body.operationName === 'string' ? { operationName: body.operationName } : {}),
    })
    const status = result.data !== undefined && result.data !== null ? 200 : 400
    return c.json(result, status)
  })

  app.get(graphqlPath, (c) =>
    c.json(
      {
        error: 'GraphQL over HTTP is POST-only.',
        usage: {
          method: 'POST',
          path: graphqlPath,
          body: { query: '...', variables: {}, operationName: null },
          playground: graphiqlPath,
        },
      },
      405,
    ),
  )

  app.get(graphiqlPath, (c) => c.html(graphiqlHtml(graphqlPath)))
}
