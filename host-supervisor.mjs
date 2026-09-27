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
 * Relaunch is OFF by default: set DSH_SUPERVISOR_RELAUNCH=1 to let it relaunch once
 * after a successful repair.
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
const exitCode = Number(opt('--exit-code', '1'))
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
if (wantRepair && hasDrift) {
  if (recent.length >= MAX_ATTEMPTS) {
    actions.push(`跳过修复：${COOLDOWN_MS / 60000} 分钟内已有 ${recent.length} 次尝试（上限 ${MAX_ATTEMPTS}），避免重启循环`)
  } else {
    const pnpm = runPnpmInstall()
    recordAttempt('pnpm-install-resync')
    writeFileSync(`${dir}\\pnpm-repair.txt`, `${pnpm.how}\n${pnpm.out}\n(exit=${pnpm.ok ? 0 : pnpm.code})\n`, 'utf8')
    const gateAfter = run(NODE, [GATE])
    const firstError = pnpm.ok ? '' : `｜首行错误：${(pnpm.out.split('\n').find((l) => l.trim() !== '') ?? '').slice(0, 120)}`
    actions.push(`R1 已执行：pnpm install（${pnpm.ok ? 'ok' : 'failed'}${firstError}）→ 重跑闸门 ${gateAfter.ok ? 'PASS（可重启）' : '仍不一致，需人工'}`)
    writeFileSync(`${dir}\\gate-after-repair.txt`, `${gateAfter.out}\n(exit=${gateAfter.ok ? 0 : gateAfter.code})\n`, 'utf8')
  }
} else if (wantRepair && !hasDrift) {
  actions.push(`无需 L0 修复：闸门${gatePassed ? '已通过' : '未通过'}且未发现副本漂移（该故障不在允许清单内）`)
  // L1 ladder, OPT-IN: hand this incident to a bounded headless repair session.
  // Off by default because it spends API tokens and lets a model edit config files
  // unattended (bounded by repair-overlay.yml: workspace-write@$DSH_HOME + never).
  if (process.env.DSH_SUPERVISOR_REPAIR_AGENT === '1') {
    const r = await runStream(NODE, [LADDER, '--ladder', '--incident', dir, '--timeout-mins', '10'], { logPath: `${dir}\\ladder-live.log` })
    // The ladder's EXIT CODE is the verdict (0 = its boot probe came back ALIVE). Keying off
    // "repair-report.md exists in the incident directory" was wrong twice over: the repair
    // session cannot write there (it works inside $DSH_HOME), and the 19:04 run therefore
    // reported "三级都没救回来" while the host had in fact been repaired.
    const repaired = r.ok
    const incidentName = dir.split('\\').pop()
    const candidates = [`${dir}\\repair-report.md`, `${HOME}\\repair-${incidentName}.md`]
    try {
      for (const entry of readdirSync(HOME)) {
        if (!entry.includes(incidentName)) continue
        const path = `${HOME}\\${entry}`
        candidates.push(statSync(path).isDirectory() ? `${path}\\repair-report.md` : path)
      }
    } catch { /* $DSH_HOME always exists in practice */ }
    const found = candidates.find((p) => existsSync(p))
    if (found !== undefined && found !== `${dir}\\repair-report.md`) {
      try { copyFileSync(found, `${dir}\\repair-report.md`) } catch { /* keep going */ }
    }
    actions.push(`L1/L1.5 修复阶梯：${repaired ? 'REPAIRED（启动探针通过）' : `未修好（exit=${r.code}）`}；报告：${found ?? '未找到（只记警告）'}`)
    if (!repaired) actions.push(`三级都没救回来 → 通用说明已放到 ${FIXED}（由固定脚本写入）`)
  } else {
    actions.push('L1 未启用（设 DSH_SUPERVISOR_REPAIR_AGENT=1 可让有界修复会话接手）')
  }
} else {
  actions.push('未请求修复（--repair 未给出）：仅收集证据')
}

// ── 4. report ─────────────────────────────────────────────────────────────
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

const relaunch = process.env.DSH_SUPERVISOR_RELAUNCH === '1' && wantRepair && hasDrift && recent.length < MAX_ATTEMPTS
if (relaunch) {
  recordAttempt('relaunch')
  run('cmd.exe', ['/c', 'start', '', LAUNCHER])
  actions.push('已请求一次重启（DSH_SUPERVISOR_RELAUNCH=1）')
} else if (process.env.DSH_SUPERVISOR_RELAUNCH === '1') {
  actions.push('未重启（修复未发生或已达上限）')
}

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
