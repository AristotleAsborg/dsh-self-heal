/**
 * gate-parse.mjs — read the composed `--dump-config` output as data.
 *
 * WHY THIS IS A SEPARATE MODULE: the gate must hand each installed module the same config OBJECT the
 * host hands it, or "the module accepted this config" means nothing. That logic needs tests, and
 * start-gate.mjs cannot be imported by a test — it is a script that reads the profile and calls
 * process.exit. So the parsing lives here and both the gate and ci-test.mjs import it.
 *
 * THE BUG THIS EXISTS FOR (measured 2026-09-27): the gate used to store every config value as the raw
 * TEXT after the colon and coerce only true/false/^\d+$. A row declaring `list: [a, b]`, `neg: -7`,
 * `float: 1.5` or a nested map therefore reached the module as the STRINGS "[alpha, beta]" / "-7" /
 * "1.5" / "". A type-checking module threw, the gate printed "配置被安装副本拒绝", and it REFUSED a
 * launch the host accepts. A gate that refuses healthy launches is worse than no gate.
 *
 * HOW THE REMAINING BUGS WERE FOUND: not by a fixture of my own — that only proves the plumbing works,
 * which is a mistake this project has on the books. Instead the output is compared against the real
 * `yaml` package over a real 657-line dump (`_diff-parse.mjs`). That found three defects a self-made
 * sample never could:
 *   1. `!!js` tags were kept as text, so a JS-valued config compared unequal to itself;
 *   2. BLOCK SCALARS (`>-`, `|`) were not handled at all — the value became the literal marker ">-",
 *      silently REPLACING a long prompt with two characters. A quietly wrong string is the worst
 *      outcome for a check whose whole job is to decide whether a config is acceptable;
 *   3. SEQUENCES OF BLOCK MAPS lost their keys — `models: [- id: x, name: y]` became the strings
 *      "id: x". The real peak-guard row uses exactly this shape (`windows: [- {…}, …]` / nested).
 * All three are now handled, and ci-test.mjs asserts the shapes the real dump actually contains.
 *
 * The dump is a YAML subset — block maps, block sequences, flow collections, block scalars, and
 * `!!js`-tagged scalars — so this is a small purpose-built reader rather than a YAML dependency
 * (the gate must run on machines where the CLI's node_modules is the only thing present).
 */

/** Indentation width of a line, used to close nested blocks. */
export function indentOf(line) {
  return ((/^(\s*)/u.exec(line) ?? ['', ''])[1]).length
}

/**
 * Coerce a YAML scalar from the dump to the value the host will actually hold.
 * Handles the `!!js` tag the dump uses for values the host evaluates, keeps quoted scalars as
 * strings (so `'9'` never becomes the number 9), and leaves anything else as text.
 *
 * @param raw - the text after the colon.
 * @returns the coerced value.
 */
/**
 * Undo YAML's quoting inside a scalar that is already known to be quoted.
 *
 * SINGLE quotes escape by DOUBLING (`'a''b'` is the four-character string `a'b`), which the previous
 * version returned verbatim as `a''b`. The real consequence was not cosmetic: the dump writes
 * `disabled: !!js '!ctx.get(''profileContext'')'`, so our reader produced
 * `!ctx.get(''profileContext'')` where the host evaluates `!ctx.get('profileContext')`, and the gate
 * compared a config that does not exist. Found 2026-09-29 by the differential test against a DSH
 * 0.2.0-rc.2 dump.
 *
 * DOUBLE quotes use backslash escapes; the `\uXXXX` forms are handled because a config value carrying a
 * literal control character would otherwise arrive as the four characters `\u0041`.
 *
 * @param body - the text between the outer quotes.
 * @param quote - the quote character that delimited it.
 * @returns the scalar's real value.
 */
function unquoteScalar(body, quote) {
  if (quote === "'") return body.replace(/''/gu, "'")
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gu, (match, esc) => {
    if (esc[0] === 'u' || esc[0] === 'x') return String.fromCodePoint(Number.parseInt(esc.slice(1), 16))
    return { n: '\n', t: '\t', r: '\r', 0: '\0', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' }[esc] ?? esc
  })
}

/**
 * Turn one scalar token into a JS value. Not a YAML parser: it covers the value shapes the dump emits.
 *
 * @param raw - the scalar text as it appears in the dump.
 * @returns the coerced value.
 */
export function coerceScalar(raw) {
  let v = String(raw).trim()
  // `!!js <expr>` marks a value the host evaluates. The gate cannot evaluate it and must not pretend
  // to; stripping the tag yields the expression text, which is what the composed config carries.
  if (v.startsWith('!!js ')) v = v.slice(5).trim()
  if (v === '') return ''
  if (v === '~' || v === 'null') return null
  if (v === 'true') return true
  if (v === 'false') return false
  if (/^-?\d+$/u.test(v)) return Number(v)
  if (/^-?\d*\.\d+$/u.test(v)) return Number(v)
  const quoted = /^(['"])(.*)\1$/u.exec(v)
  if (quoted !== null) return unquoteScalar(quoted[2], quoted[1])
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
  let v = String(raw).trim()
  if (v.startsWith('!!js ')) v = v.slice(5).trim()
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

/** True when the text after a key is a block-scalar header (`>`, `>-`, `|`, `|-`, …). */
const isBlockHeader = (v) => /^[|>][+-]?\d*$/u.test(v.trim())

/**
 * Collect a block scalar body.
 * `>` folds newlines to spaces (one trailing newline), `|` keeps them; the `-` chomping indicator
 * drops the final newline either way. A blank line inside folds to a newline, per YAML.
 *
 * @param lines - all dump lines.
 * @param startIndex - index of the key line carrying the header.
 * @param keyIndent - indentation of that key line.
 * @returns the scalar text and the index to resume scanning from.
 */
export function readBlockScalar(lines, startIndex, keyIndent) {
  // Tolerate a tag before the indicator (`url: !!js >-`), not just `key: >-`: the caller strips the
  // tag before deciding this IS a block scalar, so this function must accept the same shape.
  const header = /:\s*(?:!!js\s+)?([|>][+-]?\d*)\s*$/u.exec(lines[startIndex])
  if (header === null) return { text: '', next: startIndex + 1 }
  return readBlockBody(lines, startIndex, keyIndent, header[1], lines.length)
}

/**
 * Collect and fold a block scalar body whose header sits on line `headerIndex`.
 *
 * Split out of {@link readBlockScalar} deliberately. The sequence-item shape `- !!js >-` needs the same
 * body rules but has no `key:` for that function's header regex to match, and writing the folding a
 * second time produced two copies of chomping and blank-line logic that only had to drift once to
 * reintroduce the very bug being fixed. One implementation, two entry points.
 *
 * @param lines - all dump lines.
 * @param headerIndex - index of the line carrying the indicator.
 * @param keyIndent - indentation of the line carrying the indicator.
 * @param style - the indicator itself (`>`, `>-`, `|`, `|+`, …).
 * @param limit - exclusive line index the body must not read past.
 * @returns the scalar text and the index to resume scanning from.
 */
function readBlockBody(lines, headerIndex, keyIndent, style, limit) {
  const folded = style.startsWith('>')
  const strip = style.includes('-')
  const body = []
  let i = headerIndex + 1
  let bodyIndent
  for (; i < limit; i += 1) {
    const line = lines[i]
    if (line.trim() === '') { body.push(''); continue }
    if (bodyIndent === undefined) {
      if (indentOf(line) <= keyIndent) break
      bodyIndent = indentOf(line)
    }
    if (indentOf(line) < bodyIndent) break
    body.push(line.slice(bodyIndent))
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  let text
  if (folded) {
    let out = ''
    let pending = 0
    for (const line of body) {
      if (line === '') { pending += 1; continue }
      if (out !== '') out += pending > 0 ? '\n'.repeat(pending) : ' '
      out += line
      pending = 0
    }
    text = out
  } else {
    text = body.join('\n')
  }
  return { text: strip ? text : `${text}\n`, next: i }
}

/**
 * Read the block that starts at `startIndex`, honouring indentation.
 *
 * This is deliberately a small recursive reader rather than a pile of special cases. Each nesting
 * shape in the real dump defeated the previous ad-hoc version in turn: a block scalar as a map value
 * worked, the same scalar inside a NESTED map did not, and `- key: value` sequences lost their keys.
 * A single function that decides "map or sequence" by looking at the first line, and recurses, handles
 * all of them.
 *
 * @param lines - all dump lines.
 * @param startIndex - first line of the block.
 * @param indent - the block's indentation.
 * @returns the parsed value and the index of the first line after the block.
 */
/**
 * Read the block that starts at `startIndex` and ends before `end`.
 *
 * Two shapes defeated earlier revisions, and both are structural rather than cosmetic:
 *
 *  - SEQUENCES OF MAPS. `models:` followed by `- id: x` then `  name: y` means the item is a MAP whose
 *    keys sit at the column after "- ". An earlier version re-entered this function on the SAME line
 *    to parse that item, matched the same "- " again, and recursed until the heap died — the array came
 *    back as hundreds of empty objects. The `- ` prefix must be consumed exactly once, here.
 *  - WHERE A BLOCK ENDS. An indent comparison cannot separate "the deeper keys of this item" from "the
 *    next top-level row" in every case, so the caller passes an explicit `end` (the next row's line
 *    index) and this function never reads past it. Without that, one row's config swallowed every row
 *    after it, and 83 of 172 rows vanished from the parse.
 *
 * @param lines - all dump lines.
 * @param startIndex - first line of the block.
 * @param indent - the block's indentation.
 * @param end - exclusive line index the block must not read past.
 * @returns the parsed value and the index of the first line after the block.
 */
function readBlock(lines, startIndex, indent, end) {
  const limit = end < 0 ? lines.length : end
  let i = startIndex
  while (i < limit && lines[i].trim() === '') i += 1
  if (i >= limit) return { value: {}, next: i }

  const first = lines[i]
  if (indentOf(first) < indent) return { value: undefined, next: i }
  const isSeq = /^\s*-\s/u.test(first)
  const isMap = /^\s*[A-Za-z_][A-Za-z0-9_.-]*:/u.test(first)
  if (!isSeq && !isMap) return { value: parseFlow(first.trim()), next: i + 1 }

  const container = isSeq ? [] : {}
  while (i < limit) {
    const line = lines[i]
    if (line.trim() === '') { i += 1; continue }
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break

    if (isSeq) {
      // Every entry of this sequence starts with "- " at `indent`.
      if (lineIndent !== indent || !/^\s*-\s/u.test(line)) break
      const dash = line.indexOf('-')
      const rest = line.slice(dash + 1).trim()
      if (rest === '') {
        const child = readBlock(lines, i + 1, indentOf(lines[i + 1] ?? '  x'), end)
        container.push(child.value ?? {})
        i = child.next
        continue
      }
      // A `!!js ` prefix here is a TAG on the item, not a key. Consume it FIRST, before the map-key test
      // below, because "!!js " also matches that pattern: `- !!js process.platform === 'win32'` would
      // otherwise be read as the map { "!!js": "process.platform" } — a key that does not exist and an
      // expression truncated at its first space. The tag is dropped because the gate cannot evaluate the
      // expression and the composed config carries its text.
      //
      // The tag is consumed here rather than guarded against at the map test: a guard leaves two pieces of
      // code both deciding what a `!!js` item is, and the guard then never fires because this branch has
      // already taken it — a sensitivity run showed exactly that, passing with the guard removed.
      const tagged = /^!!js\s+(.*)$/u.exec(rest)
      const item0 = tagged === null ? rest : tagged[1]
      if (tagged !== null && isBlockHeader(item0)) {
        // `- !!js >-` with its folded body on the following lines.
        const r = readBlockBody(lines, i, lineIndent, item0, limit)
        container.push(r.text)
        i = r.next
        continue
      }
      if (/^[A-Za-z_][A-Za-z0-9_.-]*:(?:\s|$)/u.test(item0)) {
        // NOT guarded with `&& !rest.startsWith('!!js')`. Such a guard is unreachable: the tag block above
        // consumes every `!!js ` item, so by this line `rest` can never start with `!!js `. Verified by
        // removing the guard — 155 checks stayed green, and the whole real dump still matched yaml row for
        // row. Unreachable guards are worse than none: they read as protection while doing nothing.
        // The item is a map; its first key sits right after "- ", and its remaining keys line up with
        // that column. Parse it directly instead of recursing on this same line.
        const itemIndent = dash + 1 + (line.slice(dash + 1).length - line.slice(dash + 1).trimStart().length)
        const item = {}
        const kv = /^([A-Za-z_][A-Za-z0-9_.-]*):(?:\s*(.*))?$/u.exec(item0)
        const key = kv[1]
        let value = (kv[2] ?? '').trim()
        if (value.startsWith('!!js ')) value = value.slice(5).trim()
        if (isBlockHeader(value)) {
          const r = readBlockScalar(lines, i, itemIndent)
          item[key] = r.text
          i = r.next
        } else if (value !== '') {
          item[key] = parseFlow(value)
          i += 1
        } else {
          const child = readBlock(lines, i + 1, itemIndent + 2, end)
          item[key] = child.value ?? {}
          i = child.next
        }
        // Remaining keys of this item are deeper than the "- " column.
        if (i < limit && lines[i].trim() !== '' && indentOf(lines[i]) > lineIndent) {
          const cont = readBlock(lines, i, itemIndent, end)
          if (cont.value !== null && typeof cont.value === 'object' && !Array.isArray(cont.value)) {
            Object.assign(item, cont.value)
          }
          i = cont.next
        }
        container.push(item)
        continue
      }
      container.push(parseFlow(item0))
      i += 1
      continue
    }

    const kv = /^\s*([A-Za-z_][A-Za-z0-9_.-]*):(?:\s*(.*))?$/u.exec(line)
    if (kv === null) { i += 1; continue }
    const key = kv[1]
    let rest = (kv[2] ?? '').trim()
    // A tag may sit between the key and a block-scalar indicator: `url: !!js >-`. Stripping it here is
    // what makes the block header reachable at all — without this the header looked like the literal
    // scalar "!!js >-" and the whole scalar below was silently dropped.
    if (rest.startsWith('!!js ')) rest = rest.slice(5).trim()
    if (isBlockHeader(rest)) {
      const { text, next } = readBlockScalar(lines, i, lineIndent)
      container[key] = text
      i = next
      continue
    }
    if (rest === '') {
      let nextIdx = i + 1
      while (nextIdx < limit && lines[nextIdx].trim() === '') nextIdx += 1
      const nextLine = nextIdx < limit ? lines[nextIdx] : undefined
      if (nextLine === undefined || indentOf(nextLine) <= lineIndent) {
        container[key] = {}
        i += 1
        continue
      }
      const child = readBlock(lines, nextIdx, indentOf(nextLine), end)
      container[key] = child.value ?? {}
      i = child.next
      continue
    }
    container[key] = parseFlow(rest)
    i += 1
  }
  return { value: container, next: i }
}

/**
 * Parse a `config:` subtree.
 *
 * @param lines - all dump lines.
 * @param startIndex - index of the `config:` line.
 * @param configIndent - its indentation.
 * @returns the config object and the index to continue scanning from.
 */
export function parseConfigBlock(lines, startIndex, configIndent, rowEnd = -1) {
  const limit = rowEnd < 0 ? lines.length : rowEnd
  let nextIdx = startIndex + 1
  while (nextIdx < limit && lines[nextIdx].trim() === '') nextIdx += 1
  if (nextIdx >= limit || indentOf(lines[nextIdx]) <= configIndent) {
    return { config: {}, next: startIndex + 1 }
  }
  const { value, next } = readBlock(lines, nextIdx, indentOf(lines[nextIdx]), rowEnd)
  return { config: value ?? {}, next }
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
  // Where the next ROW starts (or EOF). A config block must never read past it: the continuation keys
  // of a top-level row sit at the same indent as the next row, so nothing but an explicit boundary can
  // tell them apart.
  //
  // The boundary must be a TOP-LEVEL row. An earlier version matched `- id:` at ANY indentation, and
  // a row's own nested list (`models:` → `- id: deepseek-flash`) then looked like the next row — so
  // the boundary fell INSIDE the config it was meant to bound and 83 of 172 rows were swallowed. A
  // boundary detector that matches content is worse than no detector at all.
  const rowStarts = []
  for (let k = 0; k < lines.length; k += 1) {
    if (/^\s*-\s+id:\s/u.test(lines[k]) && indentOf(lines[k]) === 0) rowStarts.push(k)
  }
  const rowEnd = (idx) => {
    for (const start of rowStarts) if (start > idx) return start
    return -1
  }

  let current = null
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const idMatch = /^\s*-?\s*id:\s*(.+?)\s*$/u.exec(line)
    if (idMatch !== null) {
      current = { id: String(coerceScalar(idMatch[1])), name: undefined, config: {}, disabled: false }
      rows.set(current.id, current)
      continue
    }
    if (current === null) continue
    const nameMatch = /^\s*name:\s*(.+?)\s*$/u.exec(line)
    if (nameMatch !== null && current.name === undefined) {
      // UNQUOTE, for the same reason config values are coerced: the dump writes `name: 'pkg'` with
      // quotes, and a name left as the literal `'pkg'` never equals the package name. The gate looks
      // a row up by `row.name === depName`, so quoted names made that lookup silently never match —
      // which would skip the per-row config validation entirely, i.e. quietly disable the check this
      // parser exists to serve. Measured against a real dump 2026-09-27: 170/170 names were quoted.
      current.name = String(coerceScalar(nameMatch[1]))
      continue
    }
    if (/^\s*disabled:\s*(?:!!js\s*)?true\s*$/u.test(line)) current.disabled = true
    const cfgAt = /^\s*config:\s*$/u.exec(line)
    if (cfgAt !== null) {
      // The row ends where the NEXT top-level row begins; EOF when there is none.
      const end = rowEnd(i)
      const { config, next } = parseConfigBlock(lines, i, indentOf(line), end)
      current.config = config
      i = next - 1
    }
  }
  return [...rows.values()]
}
