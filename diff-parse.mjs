/**
 * diff-parse.mjs — differential test: our hand-written dump reader vs a real YAML parser.
 *
 * WHY THIS EXISTS (and why a fixture could not have found these): `gate-parse.mjs` is a purpose-built
 * reader for the `--dump-config` output, and it was originally checked only against a sample I wrote
 * myself. A self-made sample proves the plumbing works; it does NOT prove the reader agrees with
 * reality — this project already has that lesson on the books. Comparing against the real `yaml`
 * package over a real 657-line dump immediately found FOUR defects the fixture could not express:
 *
 *   1. `name:` kept its quotes, so `row.name === depName` never matched and the gate's per-row config
 *      validation was silently skipped — the very check that exists to catch config/code drift.
 *   2. `!!js` tags were kept as literal text, so a JS-valued config compared unequal to itself.
 *   3. BLOCK SCALARS (`>-`, `|`) were not handled: the value became the literal marker ">-", quietly
 *      REPLACING a long prompt with two characters. A silently wrong string is the worst possible
 *      outcome for a check whose whole job is to decide whether a config is acceptable.
 *   4. Sequences of block maps lost their keys (`models: [- id: x]` became the strings "id: x"), and
 *      a naive row-boundary detector matched `- id:` inside a row's own nested list, which made one
 *      row swallow every row after it (83 of 172 rows vanished).
 *
 * HOW TO READ THE RESULT: this compares every row the loader would see. A pass means our reader hands
 * modules the same config the host would; a failure prints the exact key and both values.
 *
 * GROUND TRUTH IS OPTIONAL, AND SAYS SO: if the `yaml` package cannot be resolved from a CLI install,
 * the script prints SKIP and exits 0 — but it never reports agreement without having compared. A test
 * that quietly does nothing is worse than no test, so the skip is loud and states the coverage gap.
 *
 * Usage:
 *   node diff-parse.mjs <dump.txt> [--cli <path-to-bin.js>]
 *   node diff-parse.mjs --self-test        # built-in fixtures, no CLI needed
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const { parseRows } = await import(new URL('./gate-parse.mjs', import.meta.url).href)

/** Resolve the `yaml` package from any plausible CLI anchor. Undefined when unavailable. */
function loadYaml(explicitCli) {
  const candidates = [
    explicitCli,
    process.env.DSH_SELFHEAL_CLI,
    'D:\\dsh\\runtime\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js',
    process.argv[1],
  ].filter((p) => typeof p === 'string' && p.length > 0)
  for (const anchor of candidates) {
    try {
      const req = createRequire(anchor.startsWith('file:') ? anchor : pathToFileURL(anchor).href)
      return { yaml: req('yaml'), via: anchor }
    } catch { /* try the next anchor */ }
  }
  return undefined
}

/**
 * Compare our reader against `yaml` over one dump.
 * @returns { ok, compared, withConfig, problems }
 */
export function compareOne(dump, yaml) {
  const truth = yaml.parse(dump)
  if (!Array.isArray(truth)) return { ok: false, compared: 0, withConfig: 0, problems: [`ground truth is not an array (${typeof truth})`] }

  // The loader uses the LAST occurrence of an id, because a later patch layer overrides an earlier one.
  const truthByLastId = new Map()
  for (const row of truth) {
    if (row !== null && typeof row === 'object' && typeof row.id === 'string') truthByLastId.set(row.id, row)
  }
  const mineById = new Map(parseRows(dump).map((r) => [r.id, r]))

  const problems = []
  let compared = 0
  let withConfig = 0
  for (const [id, truthRow] of truthByLastId) {
    const mineRow = mineById.get(id)
    if (mineRow === undefined) { problems.push(`${id}: missing from our output`); continue }
    compared += 1
    const truthCfg = truthRow.config ?? {}
    const mineCfg = mineRow.config ?? {}
    if (Object.keys(truthCfg).length > 0) withConfig += 1
    if (JSON.stringify(truthCfg) !== JSON.stringify(mineCfg)) {
      const keys = new Set([...Object.keys(truthCfg), ...Object.keys(mineCfg)])
      const diffs = []
      for (const k of keys) {
        const t = truthCfg[k]
        const m = mineCfg[k]
        if (JSON.stringify(t) !== JSON.stringify(m)) {
          diffs.push(`      ${k}: yaml=${JSON.stringify(t)?.slice(0, 120)}  ours=${JSON.stringify(m)?.slice(0, 120)}`)
        }
      }
      problems.push(`${id}: config differs\n${diffs.join('\n')}`)
    }
    if ((truthRow.name ?? undefined) !== (mineRow.name ?? undefined)) {
      problems.push(`${id}: name differs — yaml=${JSON.stringify(truthRow.name)} ours=${JSON.stringify(mineRow.name)}`)
    }
    if ((truthRow.disabled === true) !== (mineRow.disabled === true)) {
      problems.push(`${id}: disabled differs — yaml=${truthRow.disabled} ours=${mineRow.disabled}`)
    }
  }
  return { ok: problems.length === 0, compared, withConfig, problems }
}

// ── built-in fixtures: the four shapes that broke us, no CLI required ────────
const SELF_TEST_DUMP = [
  '# == layer one',
  '- id: top',
  "  name: 'pkg-top'",
  '  config:',
  '    models:',
  '      - id: deepseek-flash',
  '        name: DeepSeek-V41-Flash',
  '        contextWindow: 800000',
  '        inputModalities: [text, image]',
  '    windows:',
  '      - { startHour: 9, endHour: 12 }',
  '    exporter:',
  '      url: !!js >-',
  '        process.env.URL ??',
  "        'https://example.invalid/v1/logs'",
  '      compression: gzip',
  '    prompt: |-',
  '      line one',
  '      line two',
  '    offPeakWeekends: true',
  '    warningLead: -5',
  '    ratio: 1.5',
  '',
].join('\n')

if (process.argv.includes('--self-test')) {
  const yamlMod = loadYaml()
  if (yamlMod === undefined) {
    console.log('SKIP --self-test: the `yaml` package is not resolvable, so there is nothing to compare against.')
    console.log('     This run proves NOTHING about the parser. Install dsh or pass --cli <bin.js>.')
    process.exit(0)
  }
  const r = compareOne(SELF_TEST_DUMP, yamlMod.yaml)
  console.log(`self-test fixtures: compared ${r.compared} row(s), ${r.withConfig} with config`)
  if (r.ok) { console.log('self-test: our reader agrees with the YAML parser on all four known-bad shapes'); process.exit(0) }
  console.log('self-test FAILED:')
  for (const p of r.problems) console.log(`  x ${p}`)
  process.exit(1)
}

const dumpPath = process.argv[2]
if (dumpPath === undefined) {
  console.error('usage: node diff-parse.mjs <dump.txt> [--cli <bin.js>]   |   node diff-parse.mjs --self-test')
  process.exit(2)
}
if (!existsSync(dumpPath)) { console.error(`no such dump: ${dumpPath}`); process.exit(2) }
const cliArg = process.argv.includes('--cli') ? process.argv[process.argv.indexOf('--cli') + 1] : undefined
const yamlMod = loadYaml(cliArg)
if (yamlMod === undefined) {
  console.log('SKIP: the `yaml` package is not resolvable from any CLI anchor, so this run proves NOTHING.')
  console.log('     Point --cli at a dsh lib/bin.js on a machine that has it.')
  process.exit(0)
}
console.log(`ground truth via: ${yamlMod.via}`)
const dump = readFileSync(dumpPath, 'utf8')
const r = compareOne(dump, yamlMod.yaml)
console.log(`compared ${r.compared} rows; ${r.withConfig} carry a non-empty config`)
if (r.ok) {
  console.log('\nAGREEMENT: our reader matches the YAML parser on every row of this real dump')
  process.exit(0)
}
console.log(`\nDISAGREEMENTS: ${r.problems.length}`)
for (const p of r.problems.slice(0, 12)) console.log(`  x ${p}`)
if (r.problems.length > 12) console.log(`  … and ${r.problems.length - 12} more`)
process.exit(1)
