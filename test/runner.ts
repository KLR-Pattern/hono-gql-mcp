/**
 * Minimal test runner shared by unit.ts and e2e.ts — plain `node`, no
 * framework (the README's constraint: a bundler-style resolver loads two
 * `@opentelemetry/api` instances and silently breaks OTel span nesting).
 */
export const tests: Array<[name: string, fn: () => void | Promise<void>]> = []
export const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push([name, fn])
}

export async function runAll(label: string): Promise<void> {
  let failed = 0
  for (const [name, fn] of tests) {
    try {
      await fn()
      console.log(`  ✓ ${name}`)
    } catch (err) {
      failed++
      console.error(`  ✗ ${name}\n    ${err instanceof Error ? err.message : err}`)
    }
  }
  console.log(
    failed === 0
      ? `\n${label}: all ${tests.length} checks passed.`
      : `\n${label}: ${failed}/${tests.length} checks FAILED.`,
  )
  process.exit(failed === 0 ? 0 : 1)
}
