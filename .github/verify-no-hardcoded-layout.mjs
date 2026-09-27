/**
 * verify-no-hardcoded-layout.mjs — no shipped script may carry a machine-specific path IN CODE.
 *
 * WHY: the kit's contract is that the installer writes `<harness>\config\self-heal.config.json` and
 * every script resolves paths from it. That contract was broken in four scripts at once: start-gate
 * checked a hardcoded $DSH_HOME (so with `--harness` it validated the WRONG tree — in the component
 * whose only job is to refuse a bad launch), the supervisor invoked a hardcoded gate and ladder,
 * wrote its log to a hardcoded path, and looked for a pnpm entry point that no longer exists.
 * None of that is visible on the machine the kit was written on.
 *
 * WHY IT MATCHES CODE POSITIONS ONLY: the scripts legitimately mention `D:\dsh\...` in comments
 * that explain exactly this rule, and `self-heal.config.mjs` legitimately carries three defaults —
 * the bottom of its documented `env -> config file -> default` order, each overridable. A checker
 * that flagged those would be turned off within a week, which is worse than not having it.
 *
 * Usage: node .github/verify-no-hardcoded-layout.mjs      (exit 0 = clean)
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/u, '')

// The defaults that ARE allowed, each identified by its exact right-hand side. If one is edited,
// this check fails and forces the author to think about it — which is the point: the allowlist must
// not be a blanket "this file is exempt". Every entry here sits at the bottom of a documented
// override chain (`--flag` / env var first, this literal last), so a default is not a hardcode.
// (The first run of this checker found the installer's own `--harness` default, which the initial
// allowlist had missed — the count is printed on every run so a silent zero stays visible.)
const ALLOWED = new Map([
  ['self-heal.config.mjs', [
    "pick(env.DSH_SELFHEAL_HARNESS, 'D:\\\\dsh')",
    "pick(env.DSH_SELFHEAL_NODE, 'D:\\\\dsh\\\\runtime\\\\node\\\\node.exe')",
  ]],
  ['self-heal-install.mjs', [
    "process.env.DSH_SELFHEAL_HARNESS ?? 'D:\\\\dsh'",
  ]],
])

const FILES = ['start-gate.mjs', 'host-supervisor.mjs', 'incident-repair.mjs', 'write-host-down-readme.mjs', 'self-heal.config.mjs', 'self-heal-install.mjs']
// NOTE ON THE PATTERN: in SOURCE, a Windows path literal is written with escaped separators, so the
// bytes are `D:\\dsh` (two backslashes), not `D:\dsh`. An earlier version of this checker wrote the
// alternation as `D:\\dsh` inside a regex literal, where `\\` means ONE backslash — so it matched
// nothing, reported "0 literals found", and would have passed forever while proving nothing. Both
// forms are matched here, and the count is printed so a silent zero is visible.
const MACHINE = /D:\\\\dsh|D:\\dsh|D:\\\/dsh|D:\/dsh|D:\\\\deepseek harness|D:\\deepseek harness|D:\/deepseek harness/u

/** Comments and JSDoc are prose: they explain the rule and may name the path. */
const isComment = (line) => /^\s*(\*|\/\/|REM\b|::)/iu.test(line)

const problems = []
let scanned = 0
for (const file of FILES) {
  const lines = readFileSync(join(ROOT, file), 'utf8').split('\n')
  const allowed = ALLOWED.get(file) ?? []
  for (const [i, line] of lines.entries()) {
    if (isComment(line)) continue
    if (!MACHINE.test(line)) continue
    scanned += 1
    if (allowed.some((a) => line.includes(a))) continue
    problems.push(`${file}:${i + 1}: ${line.trim().slice(0, 120)}`)
  }
}

console.log(`scanned ${FILES.length} shipped script(s); ${scanned} code-position path literal(s) found`)
if (problems.length > 0) {
  console.error('\nMACHINE-SPECIFIC PATH IN CODE:')
  for (const p of problems) console.error(`  x ${p}`)
  console.error('\nResolve it through self-heal.config.mjs (or add a documented, overridable default).')
  process.exit(1)
}
console.log('clean: every path literal in code is a documented, overridable default')
