/**
 * MCP tools, part 2 — progressive disclosure: the 4-layer walkthrough of the
 * tag tree (list_domains → list_queries → get_query_schema → graphql_query,
 * + list_mutations when writes are on). Discovery is scoped; execution is
 * not — graphql_query always runs against the full schema. Mirrors the
 * Python bridge's mcp/progressive_tools.ts.
 */
import { z } from 'zod'
import {
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLSchema,
  printSchema,
  type GraphQLFieldConfig,
  type GraphQLObjectType as ObjType,
  type GraphQLType,
} from 'graphql'
import type { RouterGraphQLHandler } from './handler.ts'
import { groupTypeName } from './schema-builder.ts'
import { err, ok, type ToolContext } from './mcp-tools.ts'

const parseDomain = (domain: string): string[] =>
  domain
    .split(':')
    .map((s) => s.trim())
    .filter(Boolean)

function fieldBrief(name: string, field: GraphQLFieldConfig<unknown, unknown>): Record<string, unknown> {
  // NOTE: GraphQLFieldConfig.args is a RECORD (GraphQLFieldConfigMap) — unlike
  // the runtime GraphQLField, whose args are an array (see sampleDocument).
  const args = Object.entries(field.args ?? {}).map(([argName, arg]) => ({
    name: argName,
    type: String(arg.type),
    ...(arg.description ? { description: arg.description } : {}),
  }))
  return {
    name,
    type: String(field.type),
    ...(field.description ? { description: field.description } : {}),
    ...(field.deprecationReason ? { deprecated: true } : {}),
    ...(args.length > 0 ? { args } : {}),
  }
}

const unwrapType = (t: GraphQLType): GraphQLType => (t instanceof GraphQLNonNull ? t.ofType : t)

/** The group object type sitting at `path` under a root operation type. */
function walkGroup(root: ObjType | null | undefined, path: string[]): ObjType | null {
  let current: GraphQLType | null | undefined = root ?? undefined
  for (const seg of path) {
    if (!(current instanceof GraphQLObjectType)) return null
    const field = current.getFields()[seg]
    if (!field) return null
    current = unwrapType(field.type)
  }
  return current instanceof GraphQLObjectType ? current : null
}

/**
 * SDL fragment for one domain subtree, addressed exactly as in queries.
 * Re-wraps the schema's real group object up the ancestor chain with
 * sibling-free wrappers that KEEP the real group names, so the fragment's
 * field addresses match the schema while printSchema auto-collects only the
 * reachable types. (Port of the Python bridge's _domain_sdl.)
 */
export function domainSdl(handler: RouterGraphQLHandler, path: string[]): string | null {
  const { queries, mutations } = handler.registry.subtreeFields(path)
  if (queries.length === 0 && mutations.length === 0) return null

  const wrap = (root: ObjType | null | undefined, kind: 'query' | 'mutation'): ObjType | null => {
    const group = walkGroup(root, path)
    if (!group) return null
    let current: ObjType = group
    for (let depth = path.length - 1; depth >= 1; depth--) {
      const ancestors = path.slice(0, depth)
      const childSeg = path[depth]
      current = new GraphQLObjectType({
        name: groupTypeName(ancestors, kind),
        fields: { [childSeg]: { type: new GraphQLNonNull(current) } },
      })
    }
    return current
  }

  const subQueryObj = wrap(handler.schema.getQueryType(), 'query')
  if (!subQueryObj) return null
  const subQuery = new GraphQLObjectType({
    name: 'Query',
    fields: { [path[0]]: { type: new GraphQLNonNull(subQueryObj) } },
  })
  let subMutation: ObjType | undefined
  if (mutations.length > 0 && handler.schema.getMutationType()) {
    const m = wrap(handler.schema.getMutationType(), 'mutation')
    if (m) {
      subMutation = new GraphQLObjectType({
        name: 'Mutation',
        fields: { [path[0]]: { type: new GraphQLNonNull(m) } },
      })
    }
  }
  return printSchema(new GraphQLSchema({ query: subQuery, ...(subMutation ? { mutation: subMutation } : {}) }))
}

const unknownDomain = (handler: RouterGraphQLHandler, domain: string) => {
  const available = handler.registry
    .summary()
    .map((s) => s.path.join(':'))
    .join(', ')
  return err(
    `Unknown domain '${domain}'.`,
    'DOMAIN_NOT_FOUND',
    `Available top-level domains: ${available}. Use list_domains to browse the full tree.`,
  )
}

/**
 * The progressive toolset (no get_schema — discovery goes through the domain
 * fragments). Domain SDL fragments are served from the handler-level
 * sdlCache computed once per bridge (the SDK factory runs per request).
 */
export function registerProgressiveTools(
  ctx: ToolContext,
  opts: { allowMutation: boolean; sdlCache: Map<string, string> },
): void {
  const { handler, register, text, scopeFor } = ctx
  const resolve = (domain: string): string[] | null => {
    const path = parseDomain(domain)
    return handler.registry.has(path) ? path : null
  }

  register(
    'list_domains',
    {
      title: 'List domains',
      description:
        "List the API's domains (derived from route tags) with operation counts. Domains form a tree: " +
        "tag 'billing:invoice' yields domain 'billing' with subdomain 'invoice'. Untagged routes group by " +
        'their first path segment. Start here, then drill in with list_queries(domain).',
      annotations: { readOnlyHint: true },
      ...scopeFor('list_domains'),
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: text(
            ok({ domains: handler.registry.summary() }, 'Call list_queries(domain) with one of these domain paths.'),
          ),
        },
      ],
    }),
  )

  register(
    'list_queries',
    {
      title: "List a domain's Query operations",
      description:
        "List the read (Query) operations of one domain subtree — 'billing' includes its subdomains. " +
        'Each entry carries name, type, description and arguments.',
      inputSchema: z.object({
        domain: z.string().describe("Domain path from list_domains, e.g. 'billing:invoice'."),
      }),
      annotations: { readOnlyHint: true },
      ...scopeFor('list_queries'),
    },
    async ({ domain }) => {
      const path = resolve(domain)
      if (!path) return { content: [{ type: 'text', text: text(unknownDomain(handler, domain)) }] }
      const { queries } = handler.registry.subtreeFields(path)
      const fields = queries
        .filter(([owner, name]) => handler.queryFields.has(`${owner.join(':')}|${name}`))
        .sort(([a], [b]) => a.join(':').localeCompare(b.join(':')))
        .map(([owner, name]) => fieldBrief(name, handler.queryFields.get(`${owner.join(':')}|${name}`)!))
      return {
        content: [
          {
            type: 'text',
            text: text(
              ok(
                { domain, queries: fields },
                'Call get_query_schema(domain) for the full SDL fragment of these operations, then graphql_query to execute.',
              ),
            ),
          },
        ],
      }
    },
  )

  if (opts.allowMutation) {
    register(
      'list_mutations',
      {
        title: "List a domain's Mutation operations",
        description: "List the write (Mutation) operations of one domain subtree.",
        inputSchema: z.object({
          domain: z.string().describe("Domain path from list_domains, e.g. 'billing'."),
        }),
        annotations: { readOnlyHint: true },
        ...scopeFor('list_mutations'),
      },
      async ({ domain }) => {
        const path = resolve(domain)
        if (!path) return { content: [{ type: 'text', text: text(unknownDomain(handler, domain)) }] }
        const { mutations } = handler.registry.subtreeFields(path)
        const fields = mutations
          .filter(([owner, name]) => handler.mutationFields.has(`${owner.join(':')}|${name}`))
          .sort(([a], [b]) => a.join(':').localeCompare(b.join(':')))
          .map(([owner, name]) => fieldBrief(name, handler.mutationFields.get(`${owner.join(':')}|${name}`)!))
        return { content: [{ type: 'text', text: text(ok({ domain, mutations: fields })) }] }
      },
    )
  }

  register(
    'get_query_schema',
    {
      title: "Get a domain's SDL fragment",
      description:
        "The SDL fragment for one domain: its operations and every type they reach — nothing else. " +
        'Execution is NOT restricted to the domain: graphql_query runs against the full schema, ' +
        'so fields from different domains may be combined in one query.',
      inputSchema: z.object({
        domain: z.string().describe("Domain path from list_domains, e.g. 'billing:invoice'."),
      }),
      annotations: { readOnlyHint: true },
      ...scopeFor('get_query_schema'),
    },
    async ({ domain }) => {
      const path = resolve(domain)
      if (!path) return { content: [{ type: 'text', text: text(unknownDomain(handler, domain)) }] }
      const cacheKey = path.join(':')
      let sdl = opts.sdlCache.get(cacheKey)
      if (sdl === undefined) {
        const built = domainSdl(handler, path)
        if (built === null) {
          return {
            content: [
              {
                type: 'text',
                text: text(
                  err(
                    `Domain '${domain}' has no GraphQL operations.`,
                    'DOMAIN_NOT_FOUND',
                    "Pick a domain from list_domains that carries operations.",
                  ),
                ),
              },
            ],
          }
        }
        sdl = built
        opts.sdlCache.set(cacheKey, sdl)
      }
      return {
        content: [
          {
            type: 'text',
            text: text(
              ok(
                { sdl },
                'Write a GraphQL query against this fragment and run it with graphql_query (other domains may be combined too).',
              ),
            ),
          },
        ],
      }
    },
  )
}
