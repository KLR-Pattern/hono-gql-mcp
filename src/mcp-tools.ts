/**
 * MCP tools, part 1 — the sample-document builder, the simple-mode schema
 * tool, and the executor tools (graphql_query / graphql_mutation). The split
 * mirrors the Python bridge's mcp/tools.ts + progressive_tools.ts; mcp.ts
 * keeps the orchestration (buildMcpHandler) and the HTTP mount.
 *
 * Tool registration goes through ToolContext (built in mcp.ts): every tool
 * runs inside a `tools/call <name>` span, results flow through the shared
 * limitText formatter, and per-tool scope challenges attach uniformly.
 */
import { z } from 'zod'
import { GraphQLError, GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, parse, validate, type GraphQLFieldConfig, type GraphQLInputType, type GraphQLType } from 'graphql'
import type { RouterGraphQLHandler } from './handler.ts'

/** What buildMcpHandler hands each tool group — see mcp.ts for the wiring. */
export interface ToolContext {
  handler: RouterGraphQLHandler
  /** Span-wrapped registerTool with the SDK's callback arity normalized. */
  register: (name: string, config: unknown, cb: (args: any, ctx: any) => unknown) => void
  /** The shared result formatter: limitText(JSON.stringify(payload, null, 2)). */
  text: (payload: unknown) => string
  /** Per-tool scope challenge (auth.toolScopes), or {} when none. */
  scopeFor: (name: string) => Record<string, unknown>
}

// ---- envelopes -------------------------------------------------------------------

export interface Envelope {
  success: boolean
  data?: unknown
  hint?: string
  error?: string
  error_type?: string
}

export const ok = (data: unknown, hint?: string): Envelope => ({ success: true, data, ...(hint ? { hint } : {}) })
export const err = (error: string, errorType: string, hint?: string): Envelope => ({
  success: false,
  error,
  error_type: errorType,
  ...(hint ? { hint } : {}),
})

// ---- the sample document ---------------------------------------------------------

/** Peel NonNull and List wrappers down to the named type. */
const namedType = (t: GraphQLType): GraphQLType =>
  t instanceof GraphQLNonNull || t instanceof GraphQLList ? namedType(t.ofType) : t

/** The shortest valid literal for a scalar/enum leaf, so the sample needs no variables. */
function scalarLiteral(bare: GraphQLType): string {
  if (bare instanceof GraphQLEnumType) return bare.getValues()[0]?.name ?? 'FIRST'
  if (bare === GraphQLBoolean) return 'true'
  if (bare === GraphQLInt || bare === GraphQLFloat) return '0'
  return '""'
}

/**
 * A minimal VALID literal for an input type — required input-object fields
 * filled recursively (depth-capped), lists as `[]` (always legal), scalars
 * and enums via scalarLiteral. Lets the sample include REQUIRED args (a
 * mutation without them would be an example that cannot run).
 */
function inputLiteral(type: GraphQLInputType, depth: number): string {
  const bare = namedType(type)
  if (bare instanceof GraphQLEnumType) return scalarLiteral(bare)
  if (bare instanceof GraphQLInputObjectType) {
    if (depth >= 3) return '{}' // cycles fall back to invalid-on-purpose; validate() rejects
    const required = Object.entries(bare.getFields())
      .filter(([, f]) => f.type instanceof GraphQLNonNull)
      .map(([name, f]) => `${name}: ${inputLiteral(f.type, depth + 1)}`)
    return `{ ${required.join(', ')} }`
  }
  if (bare instanceof GraphQLList) return '[]'
  if (bare === GraphQLBoolean || bare === GraphQLInt || bare === GraphQLFloat) return scalarLiteral(bare)
  return bare instanceof GraphQLObjectType ? '{}' : '""'
}

/** The shortest valid selection set for a type: first scalar, else recurse one level. */
function selectFor(type: GraphQLType, depth: number, seen: Set<string>): string {
  const bare = namedType(type)
  if (!(bare instanceof GraphQLObjectType)) return ''
  if (depth >= 2 || seen.has(bare.name)) return ' { __typename }'
  const next = new Set(seen).add(bare.name)
  for (const [name, field] of Object.entries(bare.getFields())) {
    if (name.startsWith('__')) continue
    const inner = selectFor(field.type, depth + 1, next)
    return ` { ${name}${inner} }`
  }
  return ' { __typename }'
}

/**
 * A minimal valid document for the first field of one root operation, built
 * FROM the schema — for graphql_query's description (query) and
 * graphql_mutation's (mutation, which is why REQUIRED args get literals).
 *
 * Only REQUIRED (NonNull) args appear: an optional arg's literal could violate
 * the route's own zod constraints (limit: 0 against min(1) → HTTP_400 at
 * execution), while omitting it runs the route's default — the sample must be
 * runnable, not merely schema-valid.
 *
 * A hardcoded example goes stale the moment a route's operationId or response
 * schema changes, and an LLM reads this string and copies it. Derived from the
 * live schema instead, and validated before it is offered — a sample that
 * fails validation would be worse than no sample. Null when nothing can be
 * built.
 */
export function sampleDocument(schema: GraphQLSchema, operation: 'query' | 'mutation'): string | null {
  const root = operation === 'query' ? schema.getQueryType() : schema.getMutationType()
  const groups = root?.getFields()
  if (!groups) return null
  const first = Object.entries(groups)[0]
  if (!first) return null
  const [groupName, groupField] = first
  const group = namedType(groupField.type)
  if (!(group instanceof GraphQLObjectType)) return null

  const leaf = Object.entries(group.getFields())[0]
  if (!leaf) return null
  const [leafName, leafField] = leaf
  // NOTE: args is a ReadonlyArray<GraphQLArgument>, not a record — iterate it
  // directly (Object.entries here would yield index keys: `0: ""`).
  const args = (leafField.args ?? [])
    .filter((a) => a.type instanceof GraphQLNonNull)
    .map((a) => `${a.name}: ${inputLiteral(a.type, 0)}`)
    .join(', ')
  const keyword = operation === 'query' ? '' : 'mutation '
  const doc = `${keyword}{ ${groupName} { ${leafName}${args ? `(${args})` : ''}${selectFor(leafField.type, 0, new Set())} } }`
  try {
    return validate(schema, parse(doc)).length === 0 ? doc : null
  } catch {
    return null
  }
}

// ---- the tools -------------------------------------------------------------------

export function operationTypeOf(query: string): 'query' | 'mutation' | 'subscription' | null {
  const doc = parse(query)
  for (const def of doc.definitions) {
    if (def.kind === 'OperationDefinition') return def.operation
  }
  return null
}

/** Simple mode's one-shot discovery tool. */
export function registerSchemaTool(ctx: ToolContext): void {
  ctx.register(
    'get_schema',
    {
      title: 'Get the GraphQL schema',
      description:
        'The full GraphQL SDL of this service. Routes are grouped into domains by tag. ' +
        'Read this once, then compose any routes in a single graphql_query.',
      annotations: { readOnlyHint: true },
      ...ctx.scopeFor('get_schema'),
    },
    async () => ({ content: [{ type: 'text', text: ctx.text(ctx.handler.getSDL()) }] }),
  )
}

/** The executor tools, registered in BOTH modes. */
export function registerExecutorTools(
  ctx: ToolContext,
  opts: {
    /** Validated sample documents for the arg descriptions, or null when none could be built. */
    example: { query: string | null; mutation: string | null }
    allowMutation: boolean
    runDocument: (query: string, variables: Record<string, unknown> | undefined) => Promise<unknown>
  },
): void {
  const { example, allowMutation, runDocument } = opts

  ctx.register(
    'graphql_query',
    {
      title: 'Run a GraphQL query',
      description:
        'Execute a GraphQL query. Compose several routes in one document — a failing route ' +
        'nulls only its own field while siblings survive. Select only the fields you need.',
      inputSchema: z.object({
        query: z
          .string()
          .describe(`A GraphQL query document${example.query ? `, e.g. ${example.query}` : ''}`),
        variables: z.record(z.string(), z.unknown()).optional().describe('Query variables, if the document declares any'),
      }),
      annotations: { readOnlyHint: true },
      ...ctx.scopeFor('graphql_query'),
    },
    async ({ query, variables }) => {
      if (operationTypeOf(query) !== 'query') {
        throw new GraphQLError('graphql_query refuses mutation documents — use graphql_mutation for writes')
      }
      const result = await runDocument(query, variables)
      return { content: [{ type: 'text', text: ctx.text(result) }] }
    },
  )

  if (allowMutation) {
    ctx.register(
      'graphql_mutation',
      {
        title: 'Run a GraphQL mutation',
        description:
          'Execute a GraphQL mutation (writes). Mutation fields at the root run serially, in document order.',
        inputSchema: z.object({
          query: z
            .string()
            .describe(`A GraphQL mutation document${example.mutation ? `, e.g. ${example.mutation}` : ''}`),
          variables: z.record(z.string(), z.unknown()).optional(),
        }),
        annotations: { destructiveHint: true },
        ...ctx.scopeFor('graphql_mutation'),
      },
      async ({ query, variables }) => {
        if (operationTypeOf(query) !== 'mutation') {
          throw new GraphQLError('graphql_mutation only runs mutation documents')
        }
        const result = await runDocument(query, variables)
        return { content: [{ type: 'text', text: ctx.text(result) }] }
      },
    )
  }
}
