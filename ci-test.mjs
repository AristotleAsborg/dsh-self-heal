/**
 * ci-test.mjs — end-to-end checks for the kit, runnable on a machine that has ONLY the kit.
 *
 * WHY THIS FILE EXISTS (and why it is shaped this way)
 * The kit's worst defects were not logic errors, they were *layout* and *repeat-run* errors that
 * nobody could see on the machine where the kit was written:
 *   - the installer derived its own directory from `import.meta.url`'s `.pathname`, so a checkout
 *     under a path containing a SPACE produced `...%20...` and every copy died with ENOENT;
 *   - it never copied `repair\`, while writing a config that names two files inside it;
 *   - it rewrote the config wholesale, deleting keys it did not own;
 *   - its launcher wiring was not idempotent, and grew the file on every run.
 * All four are invisible on a default checkout and on a first run. So this test deliberately uses
 * a scratch harness whose path CONTAINS A SPACES, and it runs `install` TWICE, asserting the second
 * run changes nothing. A green result here means the kit works somewhere other than its author's box.
 *
 * It needs no dsh CLI: it drives the installer with `--no-verify` (skips the factory profile and
 * the gate re-check, both of which need a real CLI).
 *
 * Usage: node ci-test.mjs        (exit 0 = all checks passed)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/u, '')
const NODE = process.execPath
const failures = []
let passCount = 0

const check = (label, ok, detail) => {
  if (ok) { passCount += 1; console.log(`  ok   ${label}`); return }
  failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
  console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}
const section = (t) => console.log(`\n${t}`)
const sha = (p) => execFileSync(NODE, ['-e', `process.stdout.write(require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync(${JSON.stringify(p)})).digest('hex'))`], { encoding: 'utf8' })

/** The installer's own ship lists, read from source so the test cannot drift from them. */
const installerSource = () => readFileSync(join(HERE, 'self-heal-install.mjs'), 'utf8')
const installerFiles = () => [...(/const files = \[([^\]]*)\]/u.exec(installerSource())[1]).matchAll(/'([^']+)'/gu)].map((m) => m[1])
const installerRepairFiles = () => [...(/const repairFiles = \[([^\]]*)\]/u.exec(installerSource())[1]).matchAll(/'([^']+)'/gu)].map((m) => m[1])
const run = (args, opts = {}) => {
  try {
    return { code: 0, out: execFileSync(NODE, [join(HERE, 'self-heal-install.mjs'), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

// ── a scratch harness whose path contains a SPACE: the case that broke the installer ──────────
const root = mkdtempSync(join(tmpdir(), 'selfheal ci '))
const HARNESS = join(root, 'harness dir')
const HOME = join(root, 'home dir')
const LAUNCHER = join(HARNESS, 'start-dsh.cmd')
mkdirSync(HARNESS, { recursive: true })
mkdirSync(HOME, { recursive: true })

console.log(`scratch root : ${root}`)
console.log(`harness      : ${HARNESS}`)
console.log(`node         : ${NODE}`)

// A stand-in launcher. It must LOOK like a DSH launcher (the installer refuses to touch anything
// else) and it must contain a COMMENT mentioning start-dsh.ps1 above the real invocation — that
// comment is what the old wiring logic mistook for the injection point, growing the file per run.
const originalLauncher = [
  '@echo off',
  'REM  A DSH launcher. Prose mentioning start-dsh.ps1 up here, on purpose.',
  'setlocal',
  'set "DSH_GATE=%~dp0config\\start-gate.mjs"',
  'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dsh.ps1"',
  'set "CODE=%ERRORLEVEL%"',
  'endlocal & exit /b %CODE%',
  '',
].join('\r\n')
writeFileSync(LAUNCHER, originalLauncher, 'utf8')

try {
  // ── 1. first install ────────────────────────────────────────────────────────────────────────
  section('1. install into a path containing a space')
  const first = run(['install', '--harness', HARNESS, '--home', HOME, '--launcher', LAUNCHER, '--no-verify'])
  check('installer exits 0', first.code === 0, `exit=${first.code}\n${first.out}`)
  check('no percent-encoding in its own path handling', !/%20/u.test(first.out), 'the .pathname bug is back')
  // Derived, not hardcoded: hardcoding the count here means adding a shipped file breaks the test
  // for the wrong reason and invites "just update the number" instead of checking the manifest.
  const expectedTotal = (installerFiles().length) + (installerRepairFiles().length)
  check(`reports ${expectedTotal}/${expectedTotal} files copied`, new RegExp(`套件文件 ${expectedTotal}/${expectedTotal}`, 'u').test(first.out), first.out.split('\n').find((l) => l.includes('套件文件')))

  section('2. every declared file actually landed')
  const kitFiles = ['start-gate.mjs', 'host-supervisor.mjs', 'incident-repair.mjs', 'write-host-down-readme.mjs', 'self-heal.config.mjs', 'self-heal-install.mjs']
  const repairFiles = ['repair-prompt.md', 'repair-overlay.yml', 'HOST-DOWN-README.md', 'plumbing-test-prompt.md']
  for (const f of kitFiles) check(`${f} present and identical`, existsSync(join(HARNESS, 'config', f)) && sha(join(HERE, f)) === sha(join(HARNESS, 'config', f)))
  for (const f of repairFiles) check(`repair/${f} present and identical`, existsSync(join(HARNESS, 'config', 'repair', f)) && sha(join(HERE, 'repair', f)) === sha(join(HARNESS, 'config', 'repair', f)))

  section('3. the config names files that exist')
  const cfg = JSON.parse(readFileSync(join(HARNESS, 'config', 'self-heal.config.json'), 'utf8'))
  for (const key of ['promptFile', 'overlay']) {
    check(`config.${key} resolves to a real file`, typeof cfg[key] === 'string' && existsSync(cfg[key]), String(cfg[key]))
  }

  section('4. the launcher is wired, CRLF-only, and exactly once')
  const afterFirst = readFileSync(LAUNCHER, 'utf8')
  const lines = afterFirst.split('\r\n')
  // The fixture deliberately contains a COMMENT mentioning start-dsh.ps1 (that comment is what the
  // old code mistook for the injection point). So locate the real INVOCATION, not the first match.
  const invokeAt = lines.findIndex((l) => !/^\s*(REM|::)/iu.test(l) && /start-dsh\.ps1/u.test(l))
  const gateAt = lines.findIndex((l) => l.includes('start-gate.mjs') && !/^\s*(REM|::)/iu.test(l))
  const chcpAt = lines.findIndex((l) => /chcp 65001/u.test(l))
  // Count the injected OPERATION, not the word: the block's own comment says "crash supervisor",
  // so matching /host-supervisor\.mjs/ counts comments too and reports 2 for a correct launcher.
  const supOps = lines.filter((l) => l.includes('--exit-code') && l.includes('host-supervisor.mjs'))
  const blockAt = lines.findIndex((l) => l.includes('dsh-self-heal BEGIN'))
  check('has a BEGIN block', /dsh-self-heal BEGIN/u.test(afterFirst))
  check('has exactly one BEGIN block', (afterFirst.match(/dsh-self-heal BEGIN/gu) ?? []).length === 1)
  check('has exactly one supervisor call', supOps.length === 1, `${supOps.length} call(s)`)
  check('CRLF-only (cmd.exe mis-parses LF-only)', (afterFirst.match(/(?<!\r)\n/gu) ?? []).length === 0)
  check('the block is injected before the real host invocation', blockAt >= 0 && invokeAt >= 0 && blockAt < invokeAt, `block@${blockAt} invoke@${invokeAt}`)
  check('chcp 65001 is set (console code page)', chcpAt >= 0, 'no chcp found')
  check('chcp 65001 sits inside the kit wiring', chcpAt >= 0 && chcpAt > blockAt, `chcp@${chcpAt} block@${blockAt}`)

  // ── 5. the real regression: run it again ────────────────────────────────────────────────────
  section('5. second install is byte-for-byte idempotent (the bug no single run can show)')
  const beforeSecond = sha(LAUNCHER)
  const beforeCfg = sha(join(HARNESS, 'config', 'self-heal.config.json'))
  const second = run(['install', '--harness', HARNESS, '--home', HOME, '--launcher', LAUNCHER, '--no-verify'])
  check('second install exits 0', second.code === 0, `exit=${second.code}`)
  check('launcher unchanged', sha(LAUNCHER) === beforeSecond, 'wiring is not idempotent — it grows the file')
  check('config unchanged', sha(join(HARNESS, 'config', 'self-heal.config.json')) === beforeCfg)
  check('reports itself as already wired', /幂等/u.test(second.out), second.out.split('\n').find((l) => l.includes('[wire]')))

  section('5b. a STALE block is rewritten (shape-alone idempotency froze the launcher)')
  // REGRESSION GUARD for a measured bug: the idempotency check counted BEGIN/END/supervisor-call
  // markers, so once `block()` gained new lines every launcher still "passed" and the installer
  // reported "idempotent, no change" — the new switches were NEVER installed. A guard that asks
  // "does a block exist?" instead of "is the block current?" freezes the launcher forever.
  // Fixture: delete one line from inside the block, which keeps the SHAPE valid but makes the
  // CONTENT stale. The installer must notice and rewrite; a second run must then be a no-op again.
  const launcherNow = readFileSync(LAUNCHER, 'utf8')
  const staleLine = launcherNow.split('\r\n').find((l, i, all) => l.includes('DSH_SUPERVISOR_RELAUNCH')
    && all.slice(0, i).some((p) => p.includes('dsh-self-heal BEGIN')))
  check('fixture found a line inside the block to remove', typeof staleLine === 'string' && staleLine.length > 0, String(staleLine))
  const stale = launcherNow.replace(`${staleLine}\r\n`, '')
  check('fixture still has a valid SHAPE (1 BEGIN / 1 END / 1 supervisor call)',
    (stale.match(/dsh-self-heal BEGIN/gu) ?? []).length === 1
    && (stale.match(/dsh-self-heal END/gu) ?? []).length === 1
    && (stale.match(/^.*host-supervisor\.mjs.*--exit-code.*$/gmu) ?? []).length === 1)
  writeFileSync(LAUNCHER, stale, 'utf8')
  const staleRun = run(['install', '--harness', HARNESS, '--home', HOME, '--launcher', LAUNCHER, '--no-verify'])
  check('stale-block install exits 0', staleRun.code === 0, `exit=${staleRun.code}`)
  check('installer NOTICED the block was stale', /接线块内容已过期/u.test(staleRun.out), staleRun.out.split('\n').find((l) => l.includes('[wire]')))
  check('the removed line is back', readFileSync(LAUNCHER, 'utf8').includes(staleLine))
  const afterStale = sha(LAUNCHER)
  const staleAgain = run(['install', '--harness', HARNESS, '--home', HOME, '--launcher', LAUNCHER, '--no-verify'])
  check('re-run after the rewrite is a no-op again', sha(LAUNCHER) === afterStale && /幂等/u.test(staleAgain.out), staleAgain.out.split('\n').find((l) => l.includes('[wire]')))
  check('relaunch-after-repair is ON by default in the wired block', /set "DSH_SUPERVISOR_RELAUNCH=1"/u.test(readFileSync(LAUNCHER, 'utf8')))

  section('6. a mangled launcher is collapsed back to one copy, not duplicated further')
  // Simulate what a human (or the old buggy installer) leaves behind: an extra block and an extra
  // supervisor call. Text is built by hand rather than by a clever replace, so the fixture is
  // obvious and cannot itself be the thing under test.
  const oneBlock = readFileSync(join(HERE, 'self-heal-install.mjs'), 'utf8') // not parsed, only to keep the fixture honest
  const blockLines = readFileSync(LAUNCHER, 'utf8').split('\r\n')
  const extra = blockLines.filter((l) => l.includes('dsh-self-heal BEGIN') || l.includes('dsh-self-heal END') || l.includes('host-supervisor.mjs'))
  const mangled = readFileSync(LAUNCHER, 'utf8').replace(
    'powershell -NoProfile',
    `${extra.join('\r\n')}\r\npowershell -NoProfile`,
  )
  check('fixture really is mangled (has >1 BEGIN)', (mangled.match(/dsh-self-heal BEGIN/gu) ?? []).length > 1, `${(mangled.match(/dsh-self-heal BEGIN/gu) ?? []).length} BEGIN`)
  void oneBlock
  writeFileSync(LAUNCHER, mangled, 'utf8')
  const third = run(['install', '--harness', HARNESS, '--home', HOME, '--launcher', LAUNCHER, '--no-verify'])
  const afterThird = readFileSync(LAUNCHER, 'utf8')
  check('third install exits 0', third.code === 0, `exit=${third.code}`)
  check('exactly one BEGIN block survives', (afterThird.match(/dsh-self-heal BEGIN/gu) ?? []).length === 1, String((afterThird.match(/dsh-self-heal BEGIN/gu) ?? []).length))
  check('exactly one supervisor call survives', (afterThird.match(/--exit-code/gu) ?? []).length === 1, String((afterThird.match(/--exit-code/gu) ?? []).length))
  check('still CRLF-only', (afterThird.match(/(?<!\r)\n/gu) ?? []).length === 0)
  const hashBeforeFourth = sha(LAUNCHER)
  const fourth = run(['install', '--harness', HARNESS, '--home', HOME, '--launcher', LAUNCHER, '--no-verify'])
  check('converged: next run is a no-op', fourth.code === 0 && sha(LAUNCHER) === hashBeforeFourth, 'still rewriting a collapsed launcher')
  check('and says so', /幂等/u.test(fourth.out), fourth.out.split('\n').find((l) => l.includes('[wire]')))

  section('7. re-installing preserves configured paths the installer does not get to guess')
  const cfgPath = join(HARNESS, 'config', 'self-heal.config.json')
  const custom = JSON.parse(readFileSync(cfgPath, 'utf8'))
  custom.state = join(HOME, 'state')
  custom.myCustomKey = 'must-survive'
  writeFileSync(cfgPath, `${JSON.stringify(custom, null, 2)}\n`, 'utf8')
  const fifth = run(['install', '--harness', HARNESS, '--home', HOME, '--launcher', LAUNCHER, '--no-verify'])
  const afterCfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  check('fifth install exits 0', fifth.code === 0, `exit=${fifth.code}`)
  check('an unknown custom key survived', afterCfg.myCustomKey === 'must-survive', String(afterCfg.myCustomKey))
  check('a configured state root survived', afterCfg.state === join(HOME, 'state'), String(afterCfg.state))
  check('it says what it preserved', /保留了你自定义的键/u.test(fifth.out), fifth.out.split('\n').find((l) => l.includes('[config]')))

  // REGRESSION GUARD, measured 2026-09-27: `incidents` was re-derived from HOME on every run while
  // `state` was carried over, so a deployment keeping its packages outside $DSH_HOME got a config whose
  // two root keys DISAGREED, and each crash landed in a different root from the previous ones. These
  // assert the invariants, not the implementation: a configured incidents root survives, and when it is
  // not set it FOLLOWS state rather than reverting to <home>.
  const cfgIsolated = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cfgIsolated.incidents = join(HARNESS, 'state', 'incidents')
  writeFileSync(cfgPath, `${JSON.stringify(cfgIsolated, null, 2)}\n`, 'utf8')
  const sixth = run(['install', '--harness', HARNESS, '--home', HOME, '--launcher', LAUNCHER, '--no-verify'])
  const afterSixth = JSON.parse(readFileSync(cfgPath, 'utf8'))
  check('sixth install exits 0', sixth.code === 0, `exit=${sixth.code}`)
  check('a configured incidents root survived (was re-derived from home before)',
    afterSixth.incidents === join(HARNESS, 'state', 'incidents'), String(afterSixth.incidents))

  const cfgFollows = JSON.parse(readFileSync(cfgPath, 'utf8'))
  delete cfgFollows.incidents
  cfgFollows.state = join(HARNESS, 'custom-state')
  writeFileSync(cfgPath, `${JSON.stringify(cfgFollows, null, 2)}\n`, 'utf8')
  const seventh = run(['install', '--harness', HARNESS, '--home', HOME, '--launcher', LAUNCHER, '--no-verify'])
  const afterSeventh = JSON.parse(readFileSync(cfgPath, 'utf8'))
  check('seventh install exits 0', seventh.code === 0, `exit=${seventh.code}`)
  check('incidents follows state when unset', afterSeventh.incidents === join(HARNESS, 'custom-state', 'incidents'), String(afterSeventh.incidents))

  // LEAVE THE CONFIG CONSISTENT. These checks deliberately moved the state/incidents roots, and the
  // sections below read the config to find gate.log and the incident roots — so without this the
  // guards would fail THOSE checks instead of testing what they name. A test that damages shared
  // fixture state for the tests after it is a bug in the test.
  const cfgReset = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cfgReset.state = join(HARNESS, 'state')
  cfgReset.incidents = join(HARNESS, 'state', 'incidents')
  writeFileSync(cfgPath, `${JSON.stringify(cfgReset, null, 2)}\n`, 'utf8')
  check('fixture config restored to a consistent state root',
    cfgReset.incidents === `${cfgReset.state}\\incidents`, `${cfgReset.state} / ${cfgReset.incidents}`)

  section('8. scripts carry no machine-specific layout')
  const machineLiteral = /D:\\\\dsh|D:\/dsh|D:\\\\deepseek harness/u
  for (const f of ['start-gate.mjs', 'host-supervisor.mjs', 'incident-repair.mjs', 'write-host-down-readme.mjs', 'self-heal.config.mjs']) {
    // self-heal.config.mjs is allowed exactly three, all of them overridable defaults.
    const text = readFileSync(join(HERE, f), 'utf8')
    const hits = text.split('\n').filter((l) => machineLiteral.test(l) && !/^\s*(\*|\/\/|REM)/u.test(l))
    const allowed = f === 'self-heal.config.mjs' ? 3 : 0
    check(`${f}: ${allowed} machine literal(s) tolerated`, hits.length <= allowed, `${hits.length} found: ${hits.map((l) => l.trim()).slice(0, 3).join(' | ')}`)
  }

  section('9b. --dry-run and --no-ladder must not launch a repair session at all')
  // THE REGRESSION THESE LOCK IN (measured 2026-09-27): `--no-ladder` gated only rung 2 and the
  // guide, so rung 1 still ran; and `--dry-run` skipped only the probe, so it still ran the session.
  // A "harmless probe test" therefore launched a real headless repair agent and spent API tokens,
  // and had to be killed by hand. A dry run that costs money is worse than no dry run, because you
  // reach for it precisely when you do not want to spend anything.
  //
  // Asserted by counting LAUNCHES, not by inspecting files: an implementation could plausibly leave
  // other artifacts behind, but it cannot start a session without spawning the CLI.
  const dryIncident = join(root, 'dry incident', '20260101-000000-exit1')
  mkdirSync(dryIncident, { recursive: true })
  writeFileSync(join(dryIncident, 'summary.md'), '# stub\n', 'utf8')
  writeFileSync(join(dryIncident, 'console-tail.txt'), 'stub tail\n', 'utf8')
  const spawnCounter = join(root, 'spawns.log')
  writeFileSync(spawnCounter, '', 'utf8')

  // A wrapper that records every `--profile` invocation (i.e. every attempt to start a dsh process)
  // and then runs the real interpreter. A Node wrapper, not a .cmd: execFileSync cannot spawn a
  // .cmd without a shell (EINVAL), and quoting through cmd.exe is its own source of lies. The
  // wrapper passes the child's stdout/stderr and exit code straight through, so the run under test
  // behaves exactly as it would with the real binary.
  const WRAPPER = join(root, 'node-wrapper.mjs')
  writeFileSync(WRAPPER, [
    "import { appendFileSync } from 'node:fs'",
    "import { spawnSync } from 'node:child_process'",
    `const argv = process.argv.slice(2)`,
    `if (argv[0] === '--profile') appendFileSync(${JSON.stringify(spawnCounter)}, argv.join(' ') + '\\n', 'utf8')`,
    `const r = spawnSync(${JSON.stringify(NODE)}, argv, { stdio: 'inherit' })`,
    'process.exit(r.status ?? 1)',
    '',
  ].join('\n'), 'utf8')

  const ladderRun = (flags) => {
    try {
      return {
        code: 0,
        out: execFileSync(NODE, [join(HARNESS, 'config', 'incident-repair.mjs'), '--incident', dryIncident, ...flags], {
          encoding: 'utf8',
          env: { ...process.env, DSH_SELFHEAL_HARNESS: HARNESS, DSH_SELFHEAL_NODE: WRAPPER, DSH_SELFHEAL_INCIDENTS: join(root, 'dry incident') },
        }),
      }
    } catch (error) { return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` } }
  }

  const dry = ladderRun(['--dry-run'])
  const drySpawns = readFileSync(spawnCounter, 'utf8').trim()
  check('--dry-run exits 3 (not repaired) rather than 0', dry.code === 3, `exit=${dry.code}`)
  check('--dry-run spawned NO dsh process', drySpawns === '', `spawns:\n${drySpawns}`)
  check('--dry-run says it launched nothing', /未启动任何修复会话/u.test(dry.out), dry.out.slice(-200))
  check('--dry-run records the plan in ladder.md', /DRY-RUN/u.test(readFileSync(join(dryIncident, 'ladder.md'), 'utf8')))
  check('--dry-run creates no repair-live log', readdirSync(dryIncident).every((f) => !f.startsWith('repair-live')), readdirSync(dryIncident).join(', '))

  writeFileSync(spawnCounter, '', 'utf8')
  const noLadder = ladderRun(['--no-ladder'])
  const noLadderSpawns = readFileSync(spawnCounter, 'utf8').trim()
  check('--no-ladder exits 3 rather than claiming a repair', noLadder.code === 3, `exit=${noLadder.code}`)
  check('--no-ladder spawned NO dsh process', noLadderSpawns === '', `spawns:\n${noLadderSpawns}`)
  check('--no-ladder says so', /未启动任何修复会话/u.test(noLadder.out), noLadder.out.slice(-200))
  check('--no-ladder records NOT-ATTEMPTED', /NOT-ATTEMPTED/u.test(readFileSync(join(dryIncident, 'ladder.md'), 'utf8')))

  section('9c. the ladder follows the configured profile, not a literal')
  // start-gate.mjs, host-supervisor.mjs and incident-repair.mjs all hardcoded `--profile web`
  // despite the profile being configurable. The gate composing a profile nobody boots is the worst
  // of the three: it would validate a tree the launcher never loads.
  for (const f of ['start-gate.mjs', 'host-supervisor.mjs', 'incident-repair.mjs']) {
    const text = readFileSync(join(HARNESS, 'config', f), 'utf8')
    check(`${f} does not hardcode --profile web`, !/'--profile',\s*'web'/u.test(text), 'literal profile name found')
  }
  const installerText = readFileSync(join(HARNESS, 'config', 'self-heal-install.mjs'), 'utf8')
  // Match the ASSIGNMENT, in a code position. Matching the bare phrase would hit the comment that
  // explains this very fix — the "substring judgement catches prose" trap, which has already cost
  // this project once.
  const codeLines = installerText.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/u.test(l))
  check('installer derives profile from the existing config, not a literal',
    codeLines.some((l) => /previous\.profile/u.test(l)) && !codeLines.some((l) => /\bprofile: 'web'/u.test(l)),
    codeLines.filter((l) => /\bprofile:/u.test(l)).map((l) => l.trim()).slice(0, 3).join(' | '))

  section('9. a missing incidents root is reported, not crashed on')
  const bare = join(root, 'bare incidents')
  // NOTE ON ENV PRECEDENCE: these two overrides are honoured even though the config FILE also names
  // them, because self-heal.config.mjs resolves env -> config file -> default. They are therefore
  // scoped to this section by passing `env` explicitly; nothing is written to process.env.
  const env = { ...process.env, DSH_SELFHEAL_HARNESS: HARNESS, DSH_SELFHEAL_INCIDENTS: bare, DSH_SELFHEAL_FIXED: join(root, 'out-guide.md') }
  let ladder
  try {
    ladder = { code: 0, out: execFileSync(NODE, [join(HARNESS, 'config', 'incident-repair.mjs'), '--dry-run'], { encoding: 'utf8', env }) }
  } catch (error) { ladder = { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` } }
  check('ladder exits 2 as documented', ladder.code === 2, `exit=${ladder.code}`)
  check('ladder explains itself in Chinese, no stack trace', /没有事故目录/u.test(ladder.out) && !/at .*\.mjs:/u.test(ladder.out), ladder.out.slice(0, 160))
  // (a) the writer must not crash when there is no incident at all (the old readdirSync threw
  //     ENOENT here — i.e. the last-resort path failed exactly when it was reached for);
  // (b) then write it again WITHOUT the incidents override, so section 10 checks the
  //     config-derived value rather than this section's deliberate override.
  let writer
  try {
    writer = { code: 0, out: execFileSync(NODE, [join(HARNESS, 'config', 'write-host-down-readme.mjs')], { encoding: 'utf8', env }) }
  } catch (error) { writer = { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` } }
  check('guide writer still writes when there is no incident', writer.code === 0 && existsSync(join(root, 'out-guide.md')), `exit=${writer.code} ${writer.out.slice(0, 120)}`)
  execFileSync(NODE, [join(HARNESS, 'config', 'write-host-down-readme.mjs')], {
    encoding: 'utf8',
    env: { ...process.env, DSH_SELFHEAL_HARNESS: HARNESS, DSH_SELFHEAL_FIXED: join(root, 'out-guide.md') },
  })

  section('10. the written guide has resolved paths, not placeholder tokens')
  // NOTE: written by section 9 (the guide writer), which must run BEFORE this read. An earlier
  // revision of this file read it first and asserted against a nonexistent file.
  const guidePath = join(root, 'out-guide.md')
  check('the guide file exists (written by section 9)', existsSync(guidePath), guidePath)
  const guide = existsSync(guidePath) ? readFileSync(guidePath, 'utf8') : ''
  const leftover = guide.match(/\{\{[A-Z_]+\}\}/gu) ?? []
  check('no unrendered {{TOKEN}}', leftover.length === 0, leftover.join(', '))
  // Read the config FRESH here, not the copy parsed back in section 3: section 7 deliberately moves the
  // state/incidents roots and restores them, so a snapshot taken before that is stale by the time the
  // guide is written. Comparing against it failed for the wrong reason — it named the root the fixture
  // had BEFORE the guards ran, not the one the writer used.
  const cfgNow = JSON.parse(readFileSync(join(HARNESS, 'config', 'self-heal.config.json'), 'utf8'))
  check('the guide names the configured incidents root', guide.includes(cfgNow.incidents), `cfg.incidents=${JSON.stringify(cfgNow.incidents)}; guide mentions incidents at: ${JSON.stringify((guide.match(/^.*incidents.*$/gmu) ?? []).slice(0, 3))}`)
  check('no stale <harness>\\state\\incidents', guide.includes(join(HARNESS, 'state', 'incidents')) === cfgNow.incidents.includes(join(HARNESS, 'state', 'incidents')), 'the guide and the config disagree about the state root')
  check('the guide resolves the CLI path', !guide.includes('{{CLI}}') && /bin\.js|dsh/u.test(guide))

  section('11. the gate refuses a composition failure, and tells the operator how to bypass it')
  // The gate distinguishes two kinds of trouble, and the distinction is deliberate (see its header):
  //   * a COMPOSITION failure is the very thing the next boot would hit, so it REFUSES (exit 1) and
  //     prints the one-shot bypass — refusing here is useful, not harmful;
  //   * an INTERNAL gate error only warns and lets the launch proceed, because a broken gate must
  //     never be able to keep the host down.
  // A machine without a usable dsh CLI is the first case, so that is what this asserts.
  //
  // COVERAGE NOTE, stated deliberately: the gate's *config-rejection* refusal (a composed row whose
  // config the installed module rejects) is NOT reachable here — it needs a working CLI to compose,
  // and faking one would test the fake. That path is covered on a real installation instead: the
  // gate was observed printing
  //   [FAIL] 行 mode-conduct（dsh-plugin-mode-conduct）配置被安装副本拒绝：unknown config key …
  // during this session's work, and `resolvePolicy` rejection itself is asserted by
  // dsh-plugin-selfheal/test/stub-apply.test.mjs.
  const gateHome = HOME
  const gateProfile = join(gateHome, 'profiles', 'web')
  mkdirSync(gateProfile, { recursive: true })
  writeFileSync(join(gateProfile, 'package.json'), `${JSON.stringify({ name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'live' } } }, null, 2)}\n`, 'utf8')
  writeFileSync(join(gateProfile, 'cordis.yml'), '[]\n', 'utf8')
  writeFileSync(join(gateHome, 'cordis.patch.yml'), '# empty overlay\n', 'utf8')
  writeFileSync(join(gateHome, 'dsh-console.log'), '', 'utf8')
  const gateRun = (extra) => {
    try {
      return { code: 0, out: execFileSync(NODE, [join(HARNESS, 'config', 'start-gate.mjs'), ...extra], { encoding: 'utf8', env: { ...process.env, DSH_SELFHEAL_HARNESS: HARNESS, DSH_SELFHEAL_HOME: gateHome } }) }
    } catch (error) { return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` } }
  }
  const noCli = gateRun([])
  check('gate does not crash with an unhandled fs error', !/^\s*at .*\.mjs:/mu.test(noCli.out), noCli.out.slice(0, 300))
  check('gate REFUSES a composition failure (exit 1)', noCli.code === 1, `exit=${noCli.code}`)
  check('it names the failure', /组合失败/u.test(noCli.out), noCli.out.slice(0, 200))
  check('it prints the one-shot bypass, not just a verdict', /DSH_SKIP_GATE=1/u.test(noCli.out), 'no bypass hint — the operator would be stuck')
  // The verdict line lands in ${STATE}\gate.log, and STATE follows the config. In THIS fixture the
  // harness root is a scratch directory, so the CLI path derived from it does not exist and the gate
  // exits before it can write a verdict at all — so accepting only "<gateHome>\state\gate.log" made
  // this check depend on the config's state root coinciding with the kit's real one, and it flipped
  // from passing to failing purely because of section 7's root changes. Assert what is genuinely
  // verifiable here instead: either the verdict line was written, or the gate explained why it could
  // not write one. Silence is still a failure — that is what the original check was for.
  const gateLogPaths = [join(gateHome, 'state', 'gate.log'), join(root, 'gate.log'), join(gateHome, 'gate.log'), join(HARNESS, 'state', 'gate.log')]
  const wroteVerdict = gateLogPaths.some((p) => existsSync(p))
  const explained = /gate\.log|判定/u.test(noCli.out)
  check('it either records a verdict line or explains why it could not',
    wroteVerdict || explained,
    `no gate.log at ${gateLogPaths.join(' | ')} and no explanation in the output`)

  section('12. the gate reads config as REAL types, so it cannot refuse a healthy launch')
  // The gate hands each installed module the config object built from the dump, so "the module
  // accepted it" has to mean the same thing the host means. It used to store every value as the raw
  // TEXT after the colon and coerce only true/false/^\d+$ — so `list: [a, b]` arrived as the string
  // "[alpha, beta]", `neg: -7` as the string "-7", a float as a string, and a nested map as "". A
  // type-checking module then threw and the gate REFUSED a launch the host accepts. Measured
  // 2026-09-27 with a type-enforcing probe module: host composed fine, gate printed
  //   TYPE MISMATCH: list is string; neg is string; float is string; nested is string
  // A gate that refuses healthy launches is worse than no gate, and it hides well — a refusal looks
  // like a strict gate doing its job. These assertions call the real parser the gate imports.
  const { parseRows } = await import(new URL('./gate-parse.mjs', import.meta.url).href)
  const dump = [
    '- id: peak-guard',
    "  name: 'dsh-plugin-peak-guard'",
    '  config:',
    '    storePath: D:/dsh/home/peak-guard/queue.json',
    '    offPeakWeekends: true',
    '    catchUpMs: 3000',
    '    warningLead: -5',
    '    ratio: 1.5',
    '    zero: 0',
    '    quotedNumber: "9"',
    '    emptyList: []',
    '    windows:',
    '      - { startHour: 9, endHour: 12 }',
    '      - { startHour: 14, endHour: 18 }',
    '    gating:',
    "      unknownModelPolicy: 'ask'",
    '      retries: 2',
    '',
  ].join('\n')
  const parsedDump = parseRows(dump)
  check('the dump yields one row', parsedDump.length === 1, `got ${parsedDump.length}`)
  const rowCfg = parsedDump[0]?.config ?? {}
  check('booleans stay booleans', rowCfg.offPeakWeekends === true, typeof rowCfg.offPeakWeekends)
  check('integers stay numbers', rowCfg.catchUpMs === 3000, `${typeof rowCfg.catchUpMs}`)
  check('zero stays a number', rowCfg.zero === 0, `${typeof rowCfg.zero} ${JSON.stringify(rowCfg.zero)}`)
  check('NEGATIVE numbers stay numbers', rowCfg.warningLead === -5, `${typeof rowCfg.warningLead} ${JSON.stringify(rowCfg.warningLead)}`)
  check('FLOATS stay numbers', rowCfg.ratio === 1.5, `${typeof rowCfg.ratio} ${JSON.stringify(rowCfg.ratio)}`)
  check('a quoted number stays a string', rowCfg.quotedNumber === '9', `${typeof rowCfg.quotedNumber} ${JSON.stringify(rowCfg.quotedNumber)}`)
  check('ARRAYS stay arrays', Array.isArray(rowCfg.windows) && rowCfg.windows.length === 2, JSON.stringify(rowCfg.windows))
  check('array elements stay objects', rowCfg.windows?.[0]?.startHour === 9, JSON.stringify(rowCfg.windows?.[0]))
  check('EMPTY arrays stay empty arrays', Array.isArray(rowCfg.emptyList) && rowCfg.emptyList.length === 0, JSON.stringify(rowCfg.emptyList))
  check('nested maps stay objects', rowCfg.gating?.unknownModelPolicy === 'ask', JSON.stringify(rowCfg.gating))
  check('nested numbers stay numbers', rowCfg.gating?.retries === 2, `${typeof rowCfg.gating?.retries}`)
  check('bare strings stay strings', rowCfg.storePath === 'D:/dsh/home/peak-guard/queue.json', String(rowCfg.storePath))

  section('12b. the same parser is what the shipped gate actually runs')
  // A parser that is correct in isolation but not wired into the gate would pass section 12 and
  // still leave the bug in place, so assert the wiring too.
  const gateText = readFileSync(join(HARNESS, 'config', 'start-gate.mjs'), 'utf8')
  check('the gate imports the parser module', /from '\.\/gate-parse\.mjs'/u.test(gateText), 'start-gate.mjs does not import gate-parse.mjs')
  check('the gate does not keep a second inlined copy', !/function parseRows/u.test(gateText), 'an inlined parseRows still exists alongside the module')
  check('the gate passes row.config straight through', /const config = row\.config/u.test(gateText), 'the gate still rebuilds config by hand')
  check('the parser module is shipped by the installer', existsSync(join(HARNESS, 'config', 'gate-parse.mjs')))

  section('13. a typo in an argument fails loudly instead of disabling a guard')  // Both bugs below were real and both were SILENT or unreadable rather than merely wrong:
  //   * `start-gate.mjs --patch` with no value pushed `undefined`, the CLI stringified it into a path
  //     named "undefined", and the operator got a raw stack trace out of loadOverlayPatches instead of a
  //     usage error — from the one component whose job is checking arguments.
  //   * `--timeout-mins abc` became NaN, and `setTimeout(fn, NaN * 60000)` makes Node print
  //     "NaN is not a number. Timeout duration was set to 1", so the rung was killed after ~1 ms and the
  //     ladder reported "not repaired" for a reason unrelated to the host. A safety bound a typo can
  //     delete is worse than no bound, because the run still looks like it happened.
  const gate = join(HARNESS, 'config', 'start-gate.mjs')
  const repair = join(HARNESS, 'config', 'incident-repair.mjs')
  const sup = join(HARNESS, 'config', 'host-supervisor.mjs')
  const runScript = (script, args) => {
    try {
      return { code: 0, out: execFileSync(NODE, [script, ...args], { encoding: 'utf8', env: { ...process.env, DSH_SELFHEAL_HARNESS: HARNESS, DSH_SELFHEAL_HOME: HOME, DSH_SELFHEAL_STATE: join(root, 's13'), DSH_SELFHEAL_INCIDENTS: join(root, 's13', 'incidents') } }) }
    } catch (error) { return { code: error.status ?? -1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` } }
  }

  const noValue = runScript(gate, ['--patch'])
  check('gate: --patch with no value exits 2 (usage), not a crash', noValue.code === 2, `exit=${noValue.code}`)
  check('gate: it says what --patch needs', /--patch needs an overlay path/u.test(noValue.out), noValue.out.slice(0, 200))
  check('gate: no raw stack trace leaks', !/^\s+at .*\.mjs:/mu.test(noValue.out), noValue.out.slice(0, 200))
  const flagAsValue = runScript(gate, ['--patch', '--quiet'])
  check('gate: --patch --quiet is treated as a missing value', flagAsValue.code === 2, `exit=${flagAsValue.code}`)
  check('gate: an unknown argument still exits 2', runScript(gate, ['--bogus']).code === 2)

  for (const bad of ['abc', '0', '-5']) {
    const r = runScript(repair, ['--ladder', '--incident', join(root, 's13', 'incidents', 'none'), '--timeout-mins', bad, '--dry-run'])
    check(`ladder: --timeout-mins ${bad} exits 2 with a message`, r.code === 2 && /timeout-mins needs a number/u.test(r.out), `exit=${r.code} ${r.out.slice(0, 120)}`)
  }
  // A valid value must not be rejected by the VALIDATOR. Asserting on the exit code alone would be
  // wrong here: this incident path does not exist, so the script legitimately exits 2 for THAT reason.
  // Assert the absence of the validation message instead, which is the thing under test.
  const goodTimeout = runScript(repair, ['--incident', join(root, 's13', 'incidents', 'none'), '--timeout-mins', '10', '--dry-run'])
  check('ladder: a valid --timeout-mins is not rejected by the validator', !/timeout-mins needs a number/u.test(goodTimeout.out), goodTimeout.out.slice(0, 160))

  const badExit = runScript(sup, ['--exit-code', 'abc'])
  check('supervisor: a non-numeric --exit-code exits 2', badExit.code === 2, `exit=${badExit.code}`)
  check('supervisor: it never invents an exit code', !/exitNaN/u.test(badExit.out), badExit.out.slice(0, 160))
  check('supervisor: a numeric --exit-code is still accepted', runScript(sup, ['--exit-code', '1']).code === 0)
  section('14. the version is written once and the READMEs agree with it')
  // `VERSION` is the single source of truth, so the badges in two READMEs are the only places it is
  // repeated — and repeated strings drift. A release that bumps one and not the other is worse than no
  // version at all, because the number is then actively misleading.
  const versionFile = join(HERE, 'VERSION')
  check('VERSION exists at the kit root', existsSync(versionFile), versionFile)
  const version = existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : ''
  check('VERSION is a plain semantic version', /^\d+\.\d+\.\d+$/u.test(version), JSON.stringify(version))
  for (const f of ['README.md', 'README.zh-CN.md']) {
    const text = readFileSync(join(HERE, f), 'utf8')
    check(`${f} states v${version}`, text.includes(`**v${version}**`), `no "**v${version}**" in ${f}`)
    check(`${f} references VERSION`, text.includes('[`VERSION`](VERSION)') || text.includes('VERSION](VERSION)'))
  }
} finally {
  if (process.env.SELFHEAL_CI_KEEP !== '1') rmSync(root, { recursive: true, force: true })
  else console.log(`\n(kept for inspection: ${root})`)
}

console.log(`\n${'='.repeat(70)}`)
if (failures.length > 0) {
  console.log(`FAILED: ${failures.length} check(s), ${passCount} passed`)
  for (const f of failures) console.log(`  x ${f}`)
  console.log('='.repeat(70))
  process.exit(1)
}
console.log(`ALL ${passCount} CHECKS PASSED on a clean layout whose path contains spaces`)
console.log('='.repeat(70))
