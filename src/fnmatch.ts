/**
 * Python fnmatch semantics for route/tag filter globs:
 * `*` matches any characters (including `/`), `?` one character,
 * `[seq]` / `[!seq]` character classes, everything else literal.
 * Case-sensitive (posix fnmatch).
 */
export function fnmatchToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      re += '.*'
    } else if (c === '?') {
      re += '.'
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close === -1) {
        re += '\\[' // unterminated → literal
        continue
      }
      let cls = pattern.slice(i + 1, close).replace(/\\/g, '\\\\').replace(/\]/g, '\\]')
      if (cls.startsWith('!')) cls = '^' + cls.slice(1)
      re += `[${cls}]`
      i = close
    } else {
      re += /[.*+?^${}()|[\]\\]/.test(c) ? '\\' + c : c
    }
  }
  return new RegExp(`^${re}$`, 's')
}
