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
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

const NODE = 'D:\\dsh\\runtime\\node\\node.exe'
const BIN = 'D:\\dsh\\runtime\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const HOME = 'D:\\dsh\\home'
const PROFILE = `${HOME}\\profiles\\web`
const HOME_PATCH = `${HOME}\\cordis.patch.yml`
const LOG = 'D:\\dsh\\dsh-console.log'
const STATE = 'D:\\dsh\\state'
const INCIDENTS = `${STATE}\\incidents`
const ATTEMPTS = `${STATE}\\repairs\\attempts.json`
const GATE = 'D:\\dsh\\config\\start-gate.mjs'

const COOLDOWN_MS = 10 * 60 * 1000
const MAX_ATTEMPTS = 1
const TAIL_LINES = 200

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

const dump = run(NODE, [BIN, '--profile', 'web', '--patch', HOME_PATCH, '--dump-config'])
writeFileSync(`${dir}\\dump-config.txt`, `${dump.out}\n(exit=${dump.ok ? 0 : dump.code})\n`, 'utf8')

// ── 2. classification ─────────────────────────────────────────────────────
const classes = []
if (/unknown config key/u.test(tail)) classes.push('config-code-skew')
if (/plugin tree failed to load|failed to apply loader entry/u.test(tail)) classes.push('entry-failure')
if (/EADDRINUSE|address already in use/u.test(tail)) classes.push('port-in-use')
if (/EPERM|EACCES|access is denied/u.test(tail)) classes.push('permission')
if (classes.length === 0) classes.push(`unknown (exit=${exitCode})`)

const driftLines = gate.out.split('\n').filter((l) => l.includes('安装副本与源码不一致'))
const hasDrift = driftLines.length > 0
const gatePassed = gate.ok || /未发现确证不一致/u.test(gate.out)

/** Run the allow-listed re-sync.
 *  NOTE: `execFileSync('...\\pnpm.cmd', ...)` FAILS on modern Node (EINVAL: spawning a
 *  .cmd without a shell is blocked since the 2024 batch-file advisory). The first
 *  version of this supervisor did exactly that and reported "pnpm install (failed)"
 *  while the same command run by hand succeeded. Prefer the JS entry; fall back to
 *  cmd.exe /c for the shim. */
const PNPM_CJS = 'D:\\dsh\\runtime\\node\\node_modules\\pnpm\\bin\\pnpm.cjs'
const PNPM_CMD = 'D:\\dsh\\runtime\\node\\pnpm.cmd'
function runPnpmInstall() {
  if (existsSync(PNPM_CJS)) return { ...run(NODE, [PNPM_CJS, 'install'], { cwd: PROFILE }), how: `node ${PNPM_CJS}` }
  return { ...run('cmd.exe', ['/c', PNPM_CMD, 'install'], { cwd: PROFILE }), how: `cmd /c ${PNPM_CMD}` }
}

// ── 3. allow-listed repair ────────────────────────────────────────────────
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
    const r = run(NODE, ['D:\\dsh\\config\\incident-repair.mjs', '--ladder', '--incident', dir, '--timeout-mins', '10'])
    const report = existsSync(`${dir}\\repair-report.md`)
    actions.push(`L1/L1.5 修复阶梯已调用（${r.ok ? 'ok' : 'failed'}）；报告：${report ? '已生成' : '未生成'}`)
    if (!report) actions.push('三级都没救回来 → 通用说明已放到 D:\\dsh\\HOST-DOWN-README.md（由固定脚本写入）')
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
  run('cmd.exe', ['/c', 'start', '', 'D:\\dsh\\start-dsh.cmd'])
  actions.push('已请求一次重启（DSH_SUPERVISOR_RELAUNCH=1）')
} else if (process.env.DSH_SUPERVISOR_RELAUNCH === '1') {
  actions.push('未重启（修复未发生或已达上限）')
}

try {
  appendFileSync(LOG, `[supervisor] incident=${dir} classes=${classes.join('|')} actions=${actions.length}\n`, 'utf8')
} catch { /* the log is a convenience */ }

say(`[supervisor] 事故目录：${dir}`)
say(`[supervisor] 分类：${classes.join(', ')}；闸门：${gatePassed ? 'PASS' : 'REFUSED'}；漂移：${hasDrift ? '有' : '无'}`)
for (const a of actions) say(`[supervisor] ${a}`)
say('[supervisor] 详见 summary.md')
process.exit(0)
