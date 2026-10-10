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

function graphiqlHtml(graphqlUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <title>GraphiQL — hono-gql-mcp</title>
  <link rel="stylesheet" href="https://unpkg.com/graphiql@3/graphiql.min.css" />
  <style>body { margin: 0; } #graphiql { height: 100vh; }</style>
</head>
<body>
  <div id="graphiql">Loading GraphiQL…</div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script src="https://unpkg.com/graphiql@3/graphiql.min.js"></script>
  <script>
    const root = ReactDOM.createRoot(document.getElementById('graphiql'))
    root.render(React.createElement(GraphiQL, {
      fetcher: (params) =>
        fetch('${graphqlUrl}', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(params),
        }).then((r) => r.json()),
    }))
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
    let body: { query?: unknown; variables?: unknown; operationName?: unknown }
    try {
      body = await c.req.json()
    } catch {
      return c.json({ errors: [{ message: 'Request body must be JSON.' }] }, 400)
    }
    if (typeof body.query !== 'string') {
      return c.json({ errors: [{ message: "Body must carry a string 'query'." }] }, 400)
    }
    const result = await handler.execute(body.query, undefined, {
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
