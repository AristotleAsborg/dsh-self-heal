/**
 * gate-parse.mjs — read the composed `--dump-config` output as data.
 *
 * WHY THIS IS A SEPARATE MODULE: the gate must hand each installed module the same config OBJECT the
 * host hands it, or "the module accepted this config" means nothing. That logic needs tests, and
 * start-gate.mjs cannot be imported by a test — it is a script that reads the profile and calls
 * process.exit. So the parsing lives here and both the gate and ci-test.mjs import it.
 *
 * THE BUG THIS EXISTS FOR (measured 2026-09-27, and it failed in the dangerous direction): the gate
 * used to store every config value as the raw TEXT after the colon and coerce only `true`/`false`/
 * `^\d+$`. A row declaring `list: [a, b]`, `neg: -7`, `float: 1.5` or a nested `nested:\n  startHour: 9`
 * therefore reached the module as the STRINGS "[alpha, beta]" / "-7" / "1.5" / "". A type-checking
 * module threw, the gate printed "配置被安装副本拒绝", and it REFUSED a launch the host accepts happily.
 * A gate that refuses healthy launches is worse than no gate, and it hides well: a refusal looks like
 * a strict gate doing its job.
 *
 * The dump is a YAML subset — block maps, block sequences, flow collections and scalars — so this is a
 * small purpose-built reader rather than a YAML dependency. It never guesses: anything it cannot place
 * is left out rather than invented.
 */

/** Indentation width of a line, used to close nested blocks. */
export function indentOf(line) {
  return ((/^(\s*)/u.exec(line) ?? ['', ''])[1]).length
}

/**
 * Coerce a YAML scalar from the dump to the value the host will actually hold.
 * Quoted scalars stay strings so `'9'` never silently becomes the number 9.
 *
 * @param raw - the text after the colon.
 * @returns the coerced value.
 */
export function coerceScalar(raw) {
  const v = raw.trim()
  if (v === '') return ''
  if (v === '~' || v === 'null') return null
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/u.test(v)) return Number(v)
  if (/^-?\d*\.\d+$/u.test(v)) return Number(v)
  const quoted = /^(['"])(.*)\1$/u.exec(v)
  if (quoted !== null) return quoted[2]
  return v
}

/** Split a flow collection body on commas that are not inside quotes or nested brackets. */
function splitFlow(body) {
  const parts = []
  let depth = 0
  let quote = null
  let cur = ''
  for (const ch of body) {
    if (quote !== null) { cur += ch; if (ch === quote) quote = null; continue }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue }
    if (ch === '[' || ch === '{') depth += 1
    if (ch === ']' || ch === '}') depth -= 1
    if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += ch
  }
  if (cur.trim() !== '') parts.push(cur)
  return parts.map((p) => p.trim()).filter((p) => p !== '')
}

/**
 * Parse a flow value: `[a, b]`, `{k: v, k2: v2}`, or a scalar.
 * @param raw - the text to parse.
 * @returns the parsed value.
 */
export function parseFlow(raw) {
  const v = raw.trim()
  if (v.startsWith('[') && v.endsWith(']')) return splitFlow(v.slice(1, -1)).map((p) => parseFlow(p))
  if (v.startsWith('{') && v.endsWith('}')) {
    const obj = {}
    for (const part of splitFlow(v.slice(1, -1))) {
      const at = part.indexOf(':')
      if (at < 0) continue
      obj[part.slice(0, at).trim()] = parseFlow(part.slice(at + 1))
    }
    return obj
  }
  return coerceScalar(v)
}

/**
 * Parse a `config:` subtree, honouring indentation so nested maps and sequences arrive as objects
 * and arrays. Stops at the first non-blank line at or above the `config:` indentation.
 *
 * @param lines - all dump lines.
 * @param startIndex - index of the `config:` line.
 * @param configIndent - its indentation.
 * @returns the config object and the index to continue scanning from.
 */
export function parseConfigBlock(lines, startIndex, configIndent) {
  const config = {}
  const stack = [{ indent: configIndent, node: config }]
  let i = startIndex + 1
  for (; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = indentOf(line)
    if (indent <= configIndent) break
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop()
    const parent = stack[stack.length - 1].node
    const seq = /^\s*-\s*(.*)$/u.exec(line)
    if (seq !== null && Array.isArray(parent)) {
      parent.push(seq[1].trim() === '' ? {} : parseFlow(seq[1]))
      continue
    }
    const kv = /^\s*([A-Za-z_][A-Za-z0-9_.-]*):(?:\s*(.*))?$/u.exec(line)
    if (kv === null) continue
    const key = kv[1]
    const rest = (kv[2] ?? '').trim()
    if (rest === '') {
      // A bare key opens a nested map or sequence; the next real line's shape decides which.
      const next = lines.slice(i + 1).find((l) => l.trim() !== '')
      const isSeq = next !== undefined && indentOf(next) > indent && /^\s*-\s/u.test(next)
      const child = isSeq ? [] : {}
      parent[key] = child
      stack.push({ indent, node: child })
      continue
    }
    parent[key] = parseFlow(rest)
  }
  return { config, next: i }
}

/**
 * Parse the composed dump into effective rows: the LAST occurrence of a row id wins, because a later
 * patch layer overrides an earlier one — that is what the loader will do.
 *
 * @param dump - the `--dump-config` output.
 * @returns array of rows with `id`, `name`, `config`, `disabled`.
 */
export function parseRows(dump) {
  const rows = new Map()
  const lines = String(dump).split('\n')
  let current = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const idMatch = /^\s*-?\s*id:\s*(\S+)\s*$/u.exec(line)
    if (idMatch !== null) {
      current = { id: idMatch[1], name: undefined, config: {}, disabled: false }
      rows.set(current.id, current)
      continue
    }
    if (current === null) continue
    const nameMatch = /^\s*name:\s*(\S+)\s*$/u.exec(line)
    if (nameMatch !== null && current.name === undefined) { current.name = nameMatch[1]; continue }
    if (/^\s*disabled:\s*true\s*$/u.test(line)) current.disabled = true
    const cfgAt = /^\s*config:\s*$/u.exec(line)
    if (cfgAt !== null) {
      const { config, next } = parseConfigBlock(lines, i, indentOf(line))
      current.config = config
      i = next - 1
    }
  }
  return [...rows.values()]
}
