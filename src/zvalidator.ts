/**
 * bridgeValidator — a zValidator that survives bridge introspection.
 *
 * Plain `@hono/zod-validator` routes cannot be derived: the schema is captured
 * in the validator's closure and nothing on the returned middleware exposes
 * it at runtime — `app.routes` gives you the handler reference and nothing
 * else. This wrapper attaches the schema (plus optional metadata) to the
 * middleware under a well-known Symbol, the same pattern rhinobase's
 * hono-openapi uses for its spec generation. The scanner reads it as a second
 * introspection source, next to the zod-openapi registry.
 *
 * ```ts
 * import { bridgeValidator } from 'hono-gql-mcp'
 *
 * app.get(
 *   '/notes/search',
 *   bridgeValidator('query', SearchQuery, { tags: ['notes'], summary: 'Search notes.' }),
 *   (c) => c.json([...]),            // responseSchema omitted → raw-JSON bucket
 * )
 * ```
 *
 * Trade-off vs zod-openapi routes: one import line replaces zero-touch —
 * that is the minimum possible, the schema itself cannot be recovered from a
 * plain zValidator closure.
 */
import { zValidator } from '@hono/zod-validator'
import type { ZodType } from 'zod'

/** Well-known Symbol the scanner looks for on route handlers. */
export const VALIDATOR_SCHEMA = Symbol.for('hono-gql-mcp/validator-schema')

/** The zod-validator targets, by what they mean to the bridge. */
export type ValidatorTarget = 'param' | 'query' | 'json' | 'form' | 'header' | 'cookie'

export interface BridgeValidatorOptions {
  /** Route tags — the domain grouping, same as zod-openapi's tags. Untagged routes group by first path segment. */
  tags?: string[]
  /** Field description (zod-openapi's summary). Without one, the field carries the derived name only. */
  summary?: string
  description?: string
  deprecated?: boolean
  /** The typed 2xx response — without it the field degrades to the raw-JSON bucket (still callable). */
  responseSchema?: ZodType
}

export interface ValidatorAttachment {
  target: ValidatorTarget
  schema: ZodType
  options: BridgeValidatorOptions
}

/** zValidator behavior unchanged (same validation, same 400s) — plus the introspection side-channel. */
export function bridgeValidator<T extends ValidatorTarget, S extends ZodType>(
  target: T,
  schema: S,
  options: BridgeValidatorOptions = {},
) {
  const mw = zValidator(target, schema)
  return Object.assign(mw, { [VALIDATOR_SCHEMA]: { target, schema, options } satisfies ValidatorAttachment })
}
