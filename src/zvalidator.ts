/**
 * zValidator (shadow re-export) — same name, same behavior, plus bridge
 * introspection.
 *
 * Routes written with plain `@hono/zod-validator` cannot be derived: the
 * schema is captured in the validator's closure and nothing on the returned
 * middleware exposes it at runtime (and ESM module namespaces are frozen, so
 * patching the original export is impossible — shadowing the import is the
 * maximum-reach, zero-call-site-change form). Point the import at this
 * package and every existing `zValidator(...)` call site keeps working,
 * unchanged, while becoming visible to the bridge:
 *
 * ```ts
 * import { zValidator } from 'hono-gql-mcp'        // the ONLY change
 *
 * app.get('/search', zValidator('query', SearchQuery), handler)   // derived
 * // bridge metadata rides the 3rd argument (or the 4th, beside a hook):
 * app.get('/notes', zValidator('query', ListQuery, {
 *   tags: ['notes'], summary: 'Browse.', responseSchema: z.array(Note),
 * }), handler)
 * app.post('/notes', zValidator('json', NewNote, myHook, { tags: ['notes'] }), handler)
 * ```
 *
 * The 3rd argument is discriminated by shape: a FUNCTION is the original
 * zValidator hook (validation behavior unchanged); a plain OBJECT is bridge
 * metadata.
 */
import { zValidator as zodValidator, type Hook } from '@hono/zod-validator'
import type { Env, Input, MiddlewareHandler, TypedResponse, ValidationTargets } from 'hono'
import type { InferInput } from 'hono/validator'
import type * as v3 from 'zod/v3'
import type { ZodSafeParseResult } from 'zod/v4'
import type * as v4 from 'zod/v4/core'
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

// ---- hono/zod-validator type machinery, replicated to keep inference -------
// Not all of it is re-exported by @hono/zod-validator, so the aliases are
// copied verbatim from its .d.mts — this is what lets `c.req.valid()` typing
// flow through the shadow exactly as through the original.

type ZodSchema = v3.ZodType | v4.$ZodType
type ZodValidatorFailureBody<T extends ZodSchema> = T extends v4.$ZodType
  ? Extract<ZodSafeParseResult<v4.output<T>>, { success: false }>
  : T extends v3.ZodType
    ? Extract<v3.SafeParseReturnType<v3.input<T>, v3.output<T>>, { success: false }>
    : never
type ZodValidatorFailureResponse<T extends ZodSchema> = Response & TypedResponse<ZodValidatorFailureBody<T>, 400, 'json'>
type zInput<T> = T extends v3.ZodType ? v3.input<T> : T extends v4.$ZodType ? v4.input<T> : never
type zOutput<T> = T extends v3.ZodType ? v3.output<T> : T extends v4.$ZodType ? v4.output<T> : never
type zInfer<T> = T extends v3.ZodType ? v3.infer<T> : T extends v4.$ZodType ? v4.infer<T> : never
type ExtractValidationResponse<VF> = VF extends (value: never, c: never) => infer R
  ? R extends Promise<infer PR>
    ? PR extends TypedResponse<infer T, infer S, infer F>
      ? Response & TypedResponse<T, S, F>
      : PR extends Response
        ? PR
        : PR extends undefined
          ? never
          : never
    : R extends TypedResponse<infer T, infer S, infer F>
      ? Response & TypedResponse<T, S, F>
      : R extends Response
        ? R
        : R extends undefined
          ? never
          : never
  : never
type HasUndefined<T> = undefined extends T ? true : false
type DefaultInput<Target extends keyof ValidationTargets, In, Out> = {
  in: HasUndefined<In> extends true
    ? { [K in Target]?: [In] extends [ValidationTargets[K]] ? In : InferInput<In, K> }
    : { [K in Target]: [In] extends [ValidationTargets[K]] ? In : InferInput<In, K> }
  out: { [K in Target]: Out }
}

// ---- the wrapper: hono's overloads + the metadata object form ---------------

export function zValidator<T extends ZodSchema, Target extends keyof ValidationTargets, E extends Env, P extends string, In = zInput<T>, Out = zOutput<T>, I extends Input = DefaultInput<Target, In, Out>, V extends I = I>(
  target: Target,
  schema: T,
  hook?: undefined,
  meta?: BridgeValidatorOptions,
): MiddlewareHandler<E, P, V, ZodValidatorFailureResponse<T>>
export function zValidator<T extends ZodSchema, Target extends keyof ValidationTargets, E extends Env, P extends string, HookFn extends Hook<InferredValue, E, P, Target, {}, T>, In = zInput<T>, Out = zOutput<T>, I extends Input = DefaultInput<Target, In, Out>, V extends I = I, InferredValue = zInfer<T>>(
  target: Target,
  schema: T,
  hook: HookFn,
  meta?: BridgeValidatorOptions,
): MiddlewareHandler<E, P, V, ExtractValidationResponse<HookFn>>
export function zValidator<T extends ZodSchema, Target extends keyof ValidationTargets, E extends Env, P extends string, In = zInput<T>, Out = zOutput<T>, I extends Input = DefaultInput<Target, In, Out>, V extends I = I>(
  target: Target,
  schema: T,
  meta: BridgeValidatorOptions,
): MiddlewareHandler<E, P, V, ZodValidatorFailureResponse<T>>
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose impl signature; the overloads above carry the types
export function zValidator(target: any, schema: any, hookOrMeta?: any, metaArg?: any): any {
  const [hook, options] =
    typeof hookOrMeta === 'function'
      ? [hookOrMeta as Hook<never, never, never>, metaArg ?? {}]
      : [undefined, (hookOrMeta as BridgeValidatorOptions | undefined) ?? {}]
  const mw = zodValidator(
    target as never,
    schema as never,
    hook as never,
    // No validationFunction pass-through: rare, and the original import stays
    // available for those callers. Everything else behaves identically.
    undefined,
  )
  return Object.assign(mw, {
    [VALIDATOR_SCHEMA]: { target, schema: schema as ZodType, options } satisfies ValidatorAttachment,
  })
}

// Re-export hono's hook type under the name callers of the ORIGINAL package
// used, so switching the import line breaks nothing type-wise.
export type { Hook }
