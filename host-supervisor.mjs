/**
 * host-supervisor.mjs — L0 remainder: incident capture + allow-listed repair.
 *
 * Called by start-dsh.cmd AFTER the host exits non-zero. It never changes the
 * launcher's exit code; it only collects evidence and (optionally) performs the one
 * repair that is provably safe and reversible:
 *
 *   ALLOW-LIST (the whole repair surface, on purpose):
 *     R1  re-sync the installed bundle copies from their local sources
 *         (`pnpm install` in the profile) when the startup gate reports byte drift;
 *         then re-run the gate. Nothing else is ever touched.
 *
 *   REPORT-ONLY classes: config/code skew, entry failure, permission errors,
 *   port already in use. These need a human or the L1 model path; the supervisor
 *   classifies them and writes everything it saw.
 *
 *   LOOP GUARD: at most MAX_ATTEMPTS repairs (and at most one relaunch) per
 *   COOLDOWN_MS. The history lives in D:\dsh\state\repairs\attempts.json. A repair
 *   loop is the classic failure mode of a supervisor, so it is capped, not trusted.
 *
 * Relaunch after a VERIFIED repair is ON by default, because the alternative was measured to be worse:
 * the kit repaired the host, reported success, and left it down, so the operator had to restart by hand.
 * "Verified" means the ladder's boot probe returned ALIVE, or L0's resync was followed by a passing gate.
 * Bounded to one relaunch per COOLDOWN_MS, so it cannot become a crash loop.
 * Opt out with DSH_NO_RELAUNCH=1 (or DSH_SUPERVISOR_RELAUNCH=0); force on with DSH_SUPERVISOR_RELAUNCH=1.
 *
 * Usage: node host-supervisor.mjs --exit-code <n> [--repair] [--print] [--no-print]
 * Exit:  always 0 (the launcher owns the exit code).
 */
import * as CFG from './self-heal.config.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const NODE = CFG.NODE
const BIN = CFG.BIN
const HOME = CFG.HOME
const PROFILE = `${HOME}\\profiles\\${CFG.PROFILE}`
const HOME_PATCH = CFG.HOME_PATCH
const LOG = CFG.LOG
const STATE = CFG.STATE
const INCIDENTS = CFG.INCIDENTS
const ATTEMPTS = CFG.ATTEMPTS
// All of these come from the kit config (self-heal.config.mjs) instead of literals: the
// installer copies this file into HARNESS\config and resolves every path from
// self-heal.config.json, so a hardcoded D:\dsh\... would make the supervisor watch the wrong
// tree, write its log to the wrong place, and invoke the wrong gate/ladder on any install
// that was pointed elsewhere with --harness.
const GATE = CFG.GATE
const LADDER = CFG.LADDER
const FIXED = CFG.FIXED
const LAUNCHER = CFG.LAUNCHER
const SUPERVISOR_LOG = join(STATE, 'supervisor.log')

const COOLDOWN_MS = CFG.COOLDOWN_MS
const MAX_ATTEMPTS = CFG.MAX_ATTEMPTS
const TAIL_LINES = CFG.TAIL_LINES

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
/**
 * Read the host exit code, refusing a value that is not a number.
 *
 * WHY: `Number('abc')` is NaN, and the exit code is not decorative — it names the incident directory at
 * `${INCIDENTS}\${stamp}-exit${exitCode}`. A mistyped value therefore produced a package called
 * `...-exitNaN` and recorded "exit=NaN" in the summary and in supervisor.log, which is a record that
 * cannot be reconciled with anything afterwards. Refuse loudly instead: this script's own contract is
 * that exit codes are evidence, so it must not invent one.
 */
const exitCodeRaw = opt('--exit-code', '1')
const exitCode = Number(exitCodeRaw)
if (!Number.isInteger(exitCode)) {
  console.error(`supervisor: --exit-code needs an integer, got ${JSON.stringify(exitCodeRaw)}`)
  process.exit(2)
}
const wantRepair = argv.includes('--repair')
const quiet = argv.includes('--no-print')
const say = (s) => { if (!quiet) console.log(s) }

const stamp = `${new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)}`
const dir = `${INCIDENTS}\\${stamp}-exit${exitCode}`
mkdirSync(dir, { recursive: true })

/** Run a command, capture stdout+stderr, never throw. */
function run(file, args, options = {}) {
  try {
    const out = execFileSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
    return { ok: true, out }
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ?? ''}`
    return { ok: false, out, code: error.status ?? null }
  }
}

/** Run a command DETACHED with its output in a file, and tail that file into this console.
 *  WHY: the previous version inherited this console, so closing the window killed the ladder,
 *  its session and every file it had not written yet — the 18:25 live-fire run left no verdict
 *  at all. Detached means the work and its evidence survive the window; the tail keeps the
 *  progress visible while the window is open. */
function runStream(file, args, options = {}) {
  const logPath = options.logPath ?? join(STATE, 'ladder-live.log')
  writeFileSync(logPath, '(detached; output mirrored here)\n', 'utf8')
  const fd = openSync(logPath, 'a')
  const child = spawn(file, args, { detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, DSH_HOME: HOME } })
  closeSync(fd)
  let seen = 0
  const tick = setInterval(() => {
    try {
      const text = readFileSync(logPath, 'utf8')
      if (text.length > seen) { process.stdout.write(text.slice(seen)); seen = text.length }
    } catch { /* still being written */ }
  }, 400)
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      clearInterval(tick)
      try { process.stdout.write(readFileSync(logPath, 'utf8').slice(seen)) } catch { /* ignore */ }
      resolve({ ok: code === 0, code, out: "see " + logPath })
    })
  })
}

// ── 1. evidence ───────────────────────────────────────────────────────────
const tail = (() => {
  try {
    return readFileSync(LOG, 'utf8').split('\n').slice(-TAIL_LINES).join('\n')
  } catch (error) {
    return `(cannot read ${LOG}: ${String(error.message)})`
  }
})()
writeFileSync(`${dir}\\console-tail.txt`, tail, 'utf8')

const gate = run(NODE, [GATE])
writeFileSync(`${dir}\\gate.txt`, `${gate.out}\n(exit=${gate.ok ? 0 : gate.code})\n`, 'utf8')

// DSH_HOME is passed explicitly: the launcher's environment does not carry it, and without it
// the CLI silently composes ANOTHER installation's home (found by the 2026-09-27 live-fire test).
const dump = run(NODE, [BIN, '--profile', CFG.PROFILE, '--patch', HOME_PATCH, '--dump-config'], { env: { ...process.env, DSH_HOME: HOME } })
writeFileSync(`${dir}\\dump-config.txt`, `${dump.out}\n(exit=${dump.ok ? 0 : dump.code})\n`, 'utf8')

// ── 2. classification ─────────────────────────────────────────────────────
// Only the LAST launch attempt counts. The first version scanned the whole 200-line tail, so the
// historical "unknown config key" text from the 16:39 boot crash labelled every later incident
// "config-code-skew" — the same history-vs-now mistake already fixed inside the gate.
const lastLaunch = tail.lastIndexOf('LAUNCH ')
const segment = lastLaunch >= 0 ? tail.slice(lastLaunch) : tail
const classes = []
if (/unknown config key/u.test(segment)) classes.push('config-code-skew')
if (/plugin tree failed to load|failed to apply loader entry/u.test(segment)) classes.push('entry-failure')
if (/EADDRINUSE|address already in use/u.test(segment)) classes.push('port-in-use')
if (/EPERM|EACCES|access is denied/u.test(segment)) classes.push('permission')
if (classes.length === 0) classes.push(`unknown (exit=${exitCode})`)

const driftLines = gate.out.split('\n').filter((l) => l.includes('安装副本与源码不一致'))
const hasDrift = driftLines.length > 0
const gatePassed = gate.ok || /未发现确证不一致/u.test(gate.out)

/** Run the allow-listed re-sync.
 *  NOTE: `execFileSync('...\\pnpm.cmd', ...)` FAILS on modern Node (EINVAL: spawning a
 *  .cmd without a shell is blocked since the 2024 batch-file advisory). The first
 *  version of this supervisor did exactly that and reported "pnpm install (failed)"
 *  while the same command run by hand succeeded. So: run the native binary directly when
 *  it exists, and only fall back to `cmd.exe /c` for the .cmd shim.
 *
 *  pnpm is located RELATIVE TO THE CONFIGURED NODE, never by literal path. Two things were
 *  wrong with the previous literals: they pointed at a D:\dsh install regardless of
 *  --harness, and the `.cjs` entry they preferred does not exist on this machine at all —
 *  this pnpm ships as a native binary (`"bin": {"pnpm": "pnpm.exe"}`), so that branch had
 *  silently become dead code. */
const PNPM_EXE = join(dirname(NODE), 'node_modules', 'pnpm', 'pnpm.exe')
const PNPM_CMD = join(dirname(NODE), 'pnpm.cmd')
function runPnpmInstall() {
  if (existsSync(PNPM_EXE)) return { ...run(PNPM_EXE, ['install'], { cwd: PROFILE }), how: PNPM_EXE }
  return { ...run('cmd.exe', ['/c', PNPM_CMD, 'install'], { cwd: PROFILE }), how: `cmd /c ${PNPM_CMD}` }
}

// ── 3. allow-listed repair ────────────────────────────────────────────────
// Write an initial summary NOW, before anything long-running starts: the 18:25 run was killed
// while the ladder was working and left no summary.md at all. The full summary below
// overwrites this one at the end.
writeFileSync(`${dir}\\summary.md`, [
  `# 宿主退出事故 ${stamp}（exit=${exitCode}）`,
  '',
  `- 分类：${classes.join(', ')}`,
  `- 闸门：${gatePassed ? 'PASS' : 'REFUSED'}`,
  `- 副本漂移：${hasDrift ? '有' : '无'}`,
  '- 状态：修复判定进行中；阶梯进度见控制台与 ladder.md / ladder-live.log',
  '',
].join('\n'), 'utf8')
const actions = []
function attempts() {
  try {
    return JSON.parse(readFileSync(ATTEMPTS, 'utf8'))
  } catch {
    return []
  }
}
function recordAttempt(action) {
  const list = attempts().filter((a) => Date.now() - a.at < COOLDOWN_MS)
  list.push({ at: Date.now(), action, incident: stamp })
  mkdirSync(`${STATE}\\repairs`, { recursive: true })
  writeFileSync(ATTEMPTS, JSON.stringify(list, null, 2), 'utf8')
  return list
}
const recent = attempts().filter((a) => Date.now() - a.at < COOLDOWN_MS)

/**
 * The L1/L1.5 ladder: hand this incident to a bounded headless repair session.
 *
 * Opt-in, and bounded by repair-overlay.yml (workspace-write@$DSH_HOME + approval never) because it
 * spends API tokens and lets a model edit config files unattended.
 */
async function runLadder() {
  if (process.env.DSH_SUPERVISOR_REPAIR_AGENT !== '1') {
    actions.push('L1 未启用（设 DSH_SUPERVISOR_REPAIR_AGENT=1 可让有界修复会话接手）')
    return
  }
  const r = await runStream(NODE, [LADDER, '--ladder', '--incident', dir, '--timeout-mins', '10'], { logPath: `${dir}\\ladder-live.log` })
  // The ladder's EXIT CODE is the verdict (0 = its boot probe came back ALIVE). Keying off
  // "repair-report.md exists in the incident directory" was wrong twice over: the repair
  // session cannot write there (it works inside $DSH_HOME), and the 19:04 run therefore
  // reported "三级都没救回来" while the host had in fact been repaired.
  const repaired = r.ok
  l1Repaired = repaired
  const incidentName = dir.split('\\').pop()
  // The agent writes its report to $DSH_HOME (A5) because the incident directory is outside its
  // workspace. Look THERE as well, or a real report is reported as "no report" — which is exactly what
  // the live 2026-09-27 incident showed in ladder.md (`报告 NEEDS-HUMAN(无报告)`) even though
  // repair-20260927141251-exit4.md existed. A report that exists but is described as missing is worse
  // than no report: it tells the operator the repair was unattended when it was not.
  const candidates = [`${dir}\\repair-report.md`, `${HOME}\\repair-${incidentName}.md`, `${HOME}\\repair-report.md`]
  try {
    for (const entry of readdirSync(HOME)) {
      if (entry.includes(incidentName) && entry.endsWith('.md')) candidates.push(`${HOME}\\${entry}`)
      if (entry === 'repair-report.md') candidates.push(`${HOME}\\${entry}`)
    }
  } catch { /* $DSH_HOME always exists in practice */ }
  const found = candidates.find((p) => existsSync(p))
  if (found !== undefined && found !== `${dir}\\repair-report.md`) {
    try { copyFileSync(found, `${dir}\\repair-report.md`) } catch { /* keep going */ }
  }
  actions.push(`L1/L1.5 修复阶梯：${repaired ? 'REPAIRED（启动探针通过）' : `未修好（exit=${r.code}）`}；报告：${found ?? '未找到（只记警告）'}`)
  if (!repaired) actions.push(`三级都没救回来 → 通用说明已放到 ${FIXED}（由固定脚本写入）`)
}

// ── L0: the one allow-listed repair, then decide whether anything is still wrong ──────────
// L0 and L1 CASCADE. They used to be mutually exclusive branches (drift => L0 only, no drift => L1),
// so the ladder was unreachable the moment drift existed — including the case that needs it most:
// drift present AND `pnpm install` unable to clear it. Measured 2026-09-27 during a live drill: a
// fatal syntax error in an installed copy produced `漂移：有`, L0 resynced it, and the ladder never ran.
let l0Repaired = false
let l1Repaired = false
if (wantRepair && hasDrift) {
  if (recent.length >= MAX_ATTEMPTS) {
    actions.push(`跳过 L0 修复：${COOLDOWN_MS / 60000} 分钟内已有 ${recent.length} 次尝试（上限 ${MAX_ATTEMPTS}），避免重启循环`)
  } else {
    const pnpm = runPnpmInstall()
    recordAttempt('pnpm-install-resync')
    writeFileSync(`${dir}\\pnpm-repair.txt`, `${pnpm.how}\n${pnpm.out}\n(exit=${pnpm.ok ? 0 : pnpm.code})\n`, 'utf8')
    const gateAfter = run(NODE, [GATE])
    l0Repaired = pnpm.ok && gateAfter.ok
    const firstError = pnpm.ok ? '' : `｜首行错误：${(pnpm.out.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 120)}`
    actions.push(`R1 已执行：pnpm install（${pnpm.ok ? 'ok' : 'failed'}${firstError}）→ 重跑闸门 ${gateAfter.ok ? 'PASS（可重启）' : '仍不一致'}`)
    writeFileSync(`${dir}\\gate-after-repair.txt`, `${gateAfter.out}\n(exit=${gateAfter.ok ? 0 : gateAfter.code})\n`, 'utf8')
  }
} else if (wantRepair && !hasDrift) {
  actions.push(`无需 L0 修复：闸门${gatePassed ? '已通过' : '未通过'}且未发现副本漂移（该故障不在 L0 的允许清单内）`)
}

// ── L1: run whenever the host exited non-zero and L0 did not demonstrably fix it ───────────
// The signal is the HOST'S NON-ZERO EXIT — that is why this supervisor is running at all. It is NOT
// "the gate now passes": the gate is deliberately fail-open and knows nothing about bootability, so a
// passing gate says nothing about whether the host can start. An earlier revision gated the ladder on
// the post-L0 gate verdict and therefore skipped it exactly when the gate was blind — measured live on
// 2026-09-27: a syntax error the gate could not see (source and installed copy byte-identical, so no
// drift) produced `闸门：PASS`, and the ladder was skipped while the host could not boot at all.
//
// Skipping is therefore an explicit OPT-IN (DSH_SELFHEAL_TRUST_L0=1) for people who would rather not
// spend a call after a clean resync. The default is to attempt the repair; a bounded ladder that runs
// when it was not needed costs one call, while one that does not run when it WAS needed leaves the
// user with a host that cannot start.
const trustL0 = process.env.DSH_SELFHEAL_TRUST_L0 === '1'
const needLadder = !wantRepair ? false : trustL0 ? !l0Repaired : true
if (!wantRepair) {
  actions.push('未请求修复（--repair 未给出）：仅收集证据')
} else if (!needLadder) {
  actions.push('L1 未运行：L0 已完成一次干净的重同步且闸门通过，而 DSH_SELFHEAL_TRUST_L0=1 要求信任该结果（省一次 API 调用）')
} else {
  if (l0Repaired && !trustL0) actions.push('L0 已重同步且闸门通过，但闸门无法证明宿主真的能启动 → 仍然运行 L1')
  if (!l0Repaired && hasDrift) actions.push('L0 未能消除漂移（或已被冷却跳过）→ 交 L1')
  if (!hasDrift) actions.push(`闸门${gatePassed ? '通过' : '未通过'}但宿主确实非零退出，而 L0 无漂移可修 → 交 L1`)
  await runLadder()
}

// ── 4. relaunch decision (BEFORE the summary, so it is actually recorded) ──
// This used to be computed AFTER summary.md was written, so the relaunch outcome was absent from both
// the summary and the printed actions — measured on a live incident 2026-09-27: the ladder verifiably
// repaired the host (`启动探针 ALIVE`), the summary said REPAIRED, and nothing anywhere said why the
// host was still down. The decision has to exist before the report that describes it.
//
// DEFAULT-ON after a VERIFIED repair. Relaunch used to need DSH_SUPERVISOR_RELAUNCH=1, which nothing in
// the launcher ever set, so a successful repair always ended with the operator restarting by hand — the
// kit fixed the fault and then left the host down. A repair that is proven by a boot probe and a passing
// gate is exactly when coming back up is safe, and the guards below bound the risk:
//   - only after a VERIFIED repair (L0 resync confirmed, or the ladder's boot probe returned ALIVE),
//   - only when the gate allows a launch right now,
//   - at most once per cooldown window (recorded in attempts.json), so a crash loop cannot form.
// Opt out with DSH_NO_RELAUNCH=1 (or force on/off with DSH_SUPERVISOR_RELAUNCH=0/1).
const relaunchOptOut = process.env.DSH_NO_RELAUNCH === '1' || process.env.DSH_SUPERVISOR_RELAUNCH === '0'
const relaunchOptIn = process.env.DSH_SUPERVISOR_RELAUNCH === '1'
const gateAllowsLaunch = run(NODE, [GATE]).ok
const repairVerified = l1Repaired || l0Repaired
const relaunchWanted = wantRepair && repairVerified && gateAllowsLaunch && !relaunchOptOut
const relaunchAllowed = relaunchWanted && (relaunchOptIn || recent.length < MAX_ATTEMPTS)
const relaunch = relaunchAllowed && recent.length < MAX_ATTEMPTS
if (!wantRepair) {
  // nothing to do
} else if (relaunch) {
  recordAttempt('relaunch')
  run('cmd.exe', ['/c', 'start', '', LAUNCHER])
  actions.push(`已自动重启一次（修复已由启动探针/闸门确认；${relaunchOptIn ? 'DSH_SUPERVISOR_RELAUNCH=1' : '默认行为'}）`)
} else if (!repairVerified) {
  actions.push('未重启：修复未被证实（没有可确认的修复结果），留给人处理')
} else if (!gateAllowsLaunch) {
  actions.push('未重启：闸门当前拒绝启动，重启会立刻再崩一次')
} else if (relaunchOptOut) {
  actions.push('未重启：DSH_NO_RELAUNCH=1 / DSH_SUPERVISOR_RELAUNCH=0 要求不重启')
} else {
  actions.push(`未重启：${COOLDOWN_MS / 60000} 分钟内已达 ${MAX_ATTEMPTS} 次尝试上限，避免重启循环`)
}

// ── 5. report ─────────────────────────────────────────────────────────────
const summary = [
  `# 宿主退出事故 ${stamp}（exit=${exitCode}）`,
  '',
  `- 分类：${classes.join(', ')}`,
  `- 闸门：${gatePassed ? 'PASS' : 'REFUSED'}`,
  `- 副本漂移：${hasDrift ? `有（${driftLines.length} 项）` : '无'}`,
  `- 动作：`,
  ...actions.map((a) => `  - ${a}`),
  '',
  '## 日志尾部（最后 25 行）',
  '',
  '```',
  tail.split('\n').slice(-25).join('\n'),
  '```',
  '',
  '## 证据文件',
  '',
  '- `console-tail.txt`：dsh-console.log 的最后 200 行',
  '- `gate.txt`：闸门输出与退出码',
  '- `dump-config.txt`：下次启动的组合树',
  existsSync(`${dir}\\gate-after-repair.txt`) ? '- `gate-after-repair.txt`：修复后重跑的闸门输出' : '',
  '',
  '## 回滚',
  '',
  'R1 只做 `pnpm install`（按 profile 的 package.json 从本地源码重建 node_modules 链接），不修改任何源码或配置；',
  '如需回退，重跑一次 `pnpm install` 即可，或删掉本目录（证据）本身。',
  ''
].filter((l) => l !== '').join('\n')
writeFileSync(`${dir}\\summary.md`, summary, 'utf8')

// Never swallow this silently: the gate had exactly that bug (an empty catch hid an EBUSY for
// a whole session). The console log is best-effort; our own log always gets the line.
const supLine = `[supervisor] incident=${dir} classes=${classes.join('|')} actions=${actions.length}`
try {
  mkdirSync(STATE, { recursive: true })
  appendFileSync(SUPERVISOR_LOG, `${supLine} ${new Date().toISOString()}\n`, 'utf8')
} catch (error) {
  say(`[supervisor] 无法写入 supervisor.log：${String(error.message).slice(0, 100)}`)
}
try {
  appendFileSync(LOG, `${supLine}\n`, 'utf8')
} catch (error) {
  say(`[supervisor] 判定未能写入 dsh-console.log（${String(error.code ?? error.message).slice(0, 40)}）—— 已记入 ${SUPERVISOR_LOG}`)
}

say(`[supervisor] 事故目录：${dir}`)
say(`[supervisor] 分类：${classes.join(', ')}；闸门：${gatePassed ? 'PASS' : 'REFUSED'}；漂移：${hasDrift ? '有' : '无'}`)
for (const a of actions) say(`[supervisor] ${a}`)
say('')
say('=================== 事故目录（证据都在这里） ===================')
say(`  ${dir}`)
say('    summary.md         分类、已做的动作、日志尾部')
say('    console-tail.txt   崩溃原文（日志最后 200 行）')
say('    gate.txt           闸门结论（该故障是否在它的覆盖范围内）')
say(`    ladder.md          L1 / L1.5 分级结果${existsSync(`${dir}\\ladder.md`) ? '' : '（本次未启用 L1）'}`)
say(`    repair-report.md   修复会话的报告${existsSync(`${dir}\\repair-report.md`) ? '' : '（未生成 → 视为 NEEDS-HUMAN）'}`)
if (existsSync(FIXED)) say(`  ${FIXED}   三级全败时写下的通用说明`)
say('==============================================================')
say('[supervisor] 详见 summary.md')
process.exit(0)
