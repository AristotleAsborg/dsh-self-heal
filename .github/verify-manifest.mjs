/**
 * verify-manifest.mjs — the kit directory and the installer's copy list must not drift apart.
 *
 * WHY: the installer ships an EXPLICIT file list (a wildcard would drag in every unrelated .mjs in
 * the checkout), so adding a file to the kit does NOT ship it. That already happened: `repair\` was
 * never copied while the config pointed straight at two files inside it, and a fresh install
 * produced a kit whose repair ladder could not start. Nothing failed loudly, because "the installer
 * ran" and "the files were delivered" are two different claims.
 *
 * This turns that into a build failure. It reads the lists out of the installer so there is exactly
 * one source of truth, then checks the directory against them in both directions.
 *
 * Usage: node .github/verify-manifest.mjs      (exit 0 = consistent)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/u, '')
const INSTALLER = join(ROOT, 'self-heal-install.mjs')
const src = readFileSync(INSTALLER, 'utf8')

/** Pull a `const name = [ 'a', 'b' ]` string array out of the installer by name. */
const arrayOf = (name) => {
  const m = new RegExp(`const ${name} = \\[([^\\]]*)\\]`, 'u').exec(src)
  if (m === null) return undefined
  return [...m[1].matchAll(/'([^']+)'/gu)].map((x) => x[1])
}

const files = arrayOf('files')
const repairFiles = arrayOf('repairFiles')
const problems = []

if (files === undefined) problems.push('could not read the installer\'s `files` list')
if (repairFiles === undefined) problems.push('could not read the installer\'s `repairFiles` list')

// 1. Everything the installer claims to ship must exist in the kit.
for (const f of files ?? []) {
  if (!existsSync(join(ROOT, f))) problems.push(`installer ships ${f}, but it is not in the kit`)
}
for (const f of repairFiles ?? []) {
  if (!existsSync(join(ROOT, 'repair', f))) problems.push(`installer ships repair/${f}, but it is not in the kit`)
}

// 2. Nothing at the top level that IS meant to be installed may be missing from the list.
//    Files that are deliberately NOT installed must be named here, so silence is never accidental.
const NOT_INSTALLED = new Set(['ci-test.mjs', 'diff-parse.mjs'])
const topLevel = readdirSync(ROOT).filter((f) => f.endsWith('.mjs'))
for (const f of topLevel) {
  if (NOT_INSTALLED.has(f)) continue
  if (!(files ?? []).includes(f)) problems.push(`${f} sits in the kit but the installer never ships it`)
}

// 3. The reverse for repair/: a contract file present but not shipped is a file the operator's
//    installation will lack.
const notInstalledRepair = new Set([])
if (existsSync(join(ROOT, 'repair'))) {
  for (const f of readdirSync(join(ROOT, 'repair'))) {
    if (notInstalledRepair.has(f)) continue
    if (!(repairFiles ?? []).includes(f)) problems.push(`repair/${f} sits in the kit but the installer never ships it`)
  }
}

console.log(`installer ships : ${(files ?? []).length} script(s) + ${(repairFiles ?? []).length} repair file(s)`)
console.log(`kit top level   : ${topLevel.length} .mjs (excluded on purpose: ${[...NOT_INSTALLED].join(', ') || 'none'})`)
console.log(`repair/         : ${existsSync(join(ROOT, 'repair')) ? readdirSync(join(ROOT, 'repair')).length : 0} file(s)`)

if (problems.length > 0) {
  console.error('\nMANIFEST DRIFT:')
  for (const p of problems) console.error(`  x ${p}`)
  console.error('\nFix self-heal-install.mjs\'s lists (or the directory) so they agree.')
  process.exit(1)
}
console.log('\nmanifest consistent: every shipped file exists, and nothing shipped-worthy is left behind')
