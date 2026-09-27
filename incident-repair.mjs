/**
 * incident-repair.mjs — the repair LADDER: L1 (headless + repair overlay) → L1.5 (factory
 * `rescue` profile, same overlay) → fixed-location general guide.
 *
 * TWO DESIGN RULES, both learned the hard way in the 2026-09-27 live-fire tests:
 *
 *  1. EVIDENCE MUST NOT DEPEND ON A WINDOW. The first streaming version used
 *     execFileSync(..., { stdio: 'inherit' }): the session's output went to the launcher
 *     console only, and when that window closed the whole tree — ladder, session and the
 *     not-yet-written ladder.md / repair-report.md — died with it. One run left nothing but
 *     the supervisor's four files. Now every rung runs DETACHED (its own process group) with
 *     stdout+stderr redirected into the incident directory, the ladder tails that file into
 *     the console for live progress, and ladder.md is rewritten after every step, so a killed
 *     ladder still records how far it got.
 *
 *  2. A VERDICT MUST BE AN OUTCOME, NOT AN EXIT CODE. A rung that exited 0 having changed
 *     nothing was recorded "ok" while the same record said "no report". The verdict is now the
 *     real boot probe of the repaired composition (scratch port, hard timeout): ALIVE means the
 *     operator can restart, and a missing agent report is only a warning.
 *
 * Usage:
 *   node incident-repair.mjs [--incident <dir>] [--prompt <file>] [--timeout-mins 10]
 *                            [--no-ladder] [--dry-run]
 *   test-only: --force-l1-fail  --force-l15-fail   (skip a rung without calling a model)
 * Exit: 0 = a rung repaired it, 2 = setup problem, 3 = not repaired (guide written).
 */
import * as CFG from './self-heal.config.mjs'
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

const NODE = CFG.NODE
const BIN = CFG.BIN
const HOME = CFG.HOME
const HOME_PATCH = CFG.HOME_PATCH
const INCIDENTS = CFG.INCIDENTS
const SESSIONS = CFG.SESSIONS
const OVERLAY = CFG.OVERLAY
const PROMPT_FILE = CFG.PROMPT_FILE
const GUIDE_WRITER = CFG.GUIDE_WRITER
const PROBE_PORT = CFG.PROBE_PORT
const PROBE_BUDGET_MS = CFG.PROBE_BUDGET_MS

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes(name)
const dryRun = flag('--dry-run')
const ladder = !flag('--no-ladder')
const promptFile = opt('--prompt', PROMPT_FILE)
const timeoutMins = Number(opt('--timeout-mins', '10'))

const newestIncident = () => {
  const dirs = readdirSync(INCIDENTS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, at: statSync(`${INCIDENTS}\\${e.name}`).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  return dirs.length === 0 ? undefined : `${INCIDENTS}\\${dirs[0].name}`
}

const incident = opt('--incident', newestIncident())
if (incident === undefined || !existsSync(incident)) {
  console.error(`incident-repair: 没有事故目录（${INCIDENTS}）`)
  process.exit(2)
}
for (const [label, path] of [['overlay', OVERLAY], ['prompt', promptFile]]) {
  if (!existsSync(path)) { console.error(`incident-repair: 缺少 ${label}：${path}`); process.exit(2) }
}

// ── compose the task (footer depends on which prompt is in use) ────────────
const contract = readFileSync(promptFile, 'utf8')
const files = readdirSync(incident).filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
const usingDefaultContract = promptFile === PROMPT_FILE
const footer = usingDefaultContract
  ? ['---', '', `事故目录：${incident}`, `其中现有文件：${files.join(', ')}`, '',
    '请现在开始：先读证据，按契约行事，最后写出 repair-report.md。']
  : ['---', '', `事故目录：${incident}`, `其中现有文件：${files.join(', ')}`, '',
    '请严格执行上面的提示词：只做它要求的事，不要做它没要求的事（包括不要写报告）。']
const task = [contract, '', ...footer].join('\n')
writeFileSync(`${incident}\\repair-task.txt`, task, 'utf8')

const BOOT_FAIL = /plugin tree failed to load|failed to apply loader entry|unknown config key|ERR_MODULE_NOT_FOUND|Cannot find (module|package)|EADDRINUSE|bad option/iu
const reportPath = `${incident}\\repair-report.md`
const verdictOf = () => {
  if (!existsSync(reportPath)) return 'NEEDS-HUMAN(无报告)'
  const text = readFileSync(reportPath, 'utf8')
  if (/READY-TO-RESTART/u.test(text)) return 'READY-TO-RESTART'
  if (/NEEDS-HUMAN/u.test(text)) return 'NEEDS-HUMAN'
  return '报告无明确结论'
}

/** Boot the CURRENT web composition on a scratch port and see whether it survives. This is
 *  the falsifiable check: an exit code cannot tell us that a host boots. */
function bootProbe() {
  const log = `${incident}\\boot-probe.log`
  writeFileSync(log, `(probe: port ${PROBE_PORT}, budget ${PROBE_BUDGET_MS / 1000}s)\n`, 'utf8')
  const child = spawn(NODE, [BIN, '--profile', 'web', '--patch', HOME_PATCH, '--no-open', '--port', String(PROBE_PORT)], {
    cwd: HOME, env: { ...process.env, DSH_HOME: HOME }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  return new Promise((resolve) => {
    let out = ''
    let settled = false
    const finish = (verdict) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* already gone */ }
      writeFileSync(log, `${out}\n(probe verdict: ${verdict})\n`, 'utf8')
      resolve(verdict)
    }
    const timer = setTimeout(() => finish('ALIVE（撑过预算，未见 URL）'), PROBE_BUDGET_MS)
    child.stdout.on('data', (d) => { out += d; if (/dsh web: http/u.test(out)) finish('ALIVE（已 announce URL）') })
    child.stderr.on('data', (d) => { out += d; if (BOOT_FAIL.test(out)) finish('DEAD（组合加载失败）') })
    child.on('exit', (code) => finish(code === 0 ? 'EXITED-0（未 announce URL）' : `DEAD（exit=${code}）`))
  })
}

/** Run one rung DETACHED so closing the console cannot destroy it, tail its log into this
 *  console for live progress, and return the process outcome plus the durable output. */
let rungSeq = 0
function runDetached({ label, profile, forcedFail }) {
  const dshArgs = [BIN, '--profile', profile, '--patch', OVERLAY, 'headless', task]
  const printable = `${NODE} ${BIN} --profile ${profile} --patch ${OVERLAY} headless "<${task.length} 字符任务>"`
  if (dshArgs[0] !== BIN || dshArgs[1] !== '--profile' || dshArgs[3] !== '--patch') {
    console.error('incident-repair: 内部断言失败：执行参数与预期形状不一致')
    process.exit(2)
  }
  rungSeq += 1
  const logPath = `${incident}\\repair-live-${rungSeq}.log`
  writeFileSync(logPath, `(detached rung; DSH_HOME=${HOME})\n`, 'utf8')
  console.log(`\n[repair] ${label}`)
  console.log(`[repair] 命令：${printable}`)
  console.log(`[repair] DSH_HOME=${HOME}（显式传递；不传 CLI 会回落到默认 home）`)
  console.log(`[repair] 现场日志（与窗口无关）：${logPath}`)
  if (forcedFail === true) { writeFileSync(logPath, '(test-only forced failure)\n', 'utf8'); return Promise.resolve({ ok: false, code: 'forced', out: '(forced)' }) }
  if (dryRun) { writeFileSync(logPath, '(dry-run)\n', 'utf8'); return Promise.resolve({ ok: true, code: 'dry-run', out: '(dry-run)' }) }

  const fd = openSync(logPath, 'a')
  const child = spawn(NODE, dshArgs, {
    cwd: HOME, env: { ...process.env, DSH_HOME: HOME }, detached: true, stdio: ['ignore', fd, fd],
  })
  closeSync(fd)
  let seen = 0
  const tick = setInterval(() => {
    try {
      const text = readFileSync(logPath, 'utf8')
      if (text.length > seen) { process.stdout.write(text.slice(seen)); seen = text.length }
    } catch { /* still being written */ }
  }, 400)
  const killTimer = setTimeout(() => { try { child.kill() } catch { /* gone */ } }, timeoutMins * 60 * 1000)
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      clearInterval(tick)
      clearTimeout(killTimer)
      const out = readFileSync(logPath, 'utf8')
      process.stdout.write(out.slice(seen))
      resolve({ ok: code === 0, code, out, bootFailure: BOOT_FAIL.test(out) })
    })
  })
}

const rungs = []
function writeLadder(pending) {
  writeFileSync(`${incident}\\ladder.md`, [
    `# 修复阶梯结果（${pending}）`,
    '',
    `- 事故目录：${incident}`,
    '- 判据：**启动探针**（能启动即算修好；报告缺失只记警告；进程退出码不算数）',
    '',
    '| 级 | 进程 | 报告 | 启动探针 | 判定 |',
    '| --- | --- | --- | --- | --- |',
    ...rungs.map((r) => `| ${r.label} | ${r.process} | ${r.report} | ${r.probe ?? '—'} | ${r.verdict} |`),
    '',
  ].join('\n'), 'utf8')
}

async function runRung({ label, profile, forcedFail }) {
  const r = await runDetached({ label, profile, forcedFail })
  const report = verdictOf()
  const probe = dryRun ? '（dry-run 未探测）' : await bootProbe()
  const processText = r.ok ? 'ok' : `failed(exit=${r.code})`
  // CRITERION (relaxed by operator decision 2026-09-27): the BOOT PROBE decides. A missing or
  // inconclusive report is a warning, not a veto — if the composition boots, the operator can
  // restart, which is the only question this ladder exists to answer.
  const repaired = /^ALIVE/u.test(probe)
  const warnText = existsSync(reportPath) ? '' : '（无报告：警告，不否决）'
  rungs.push({ label, process: processText, report, probe, verdict: repaired ? 'REPAIRED' : 'NOT-REPAIRED' })
  writeLadder(`${label} 已结束`)
  console.log(`[repair] ${label} → 进程 ${processText}；报告 ${report}；启动探针 ${probe} ⇒ ${repaired ? 'REPAIRED ✓' : 'NOT-REPAIRED'}${warnText}`)
  return repaired
}

// ── rung 1: L1 ─────────────────────────────────────────────────────────────
let repaired = await runRung({ label: 'L1 headless + 修复 overlay', profile: 'headless', forcedFail: flag('--force-l1-fail') })

// ── rung 2: L1.5 factory profile ───────────────────────────────────────────
if (ladder && !repaired) {
  if (!existsSync(`${HOME}\\profiles\\rescue`)) {
    rungs.push({ label: 'L1.5 rescue', process: 'missing-profile', report: '—', probe: '—', verdict: 'NOT-REPAIRED' })
    writeLadder('L1.5 缺 profile')
    console.log('[repair] L1.5：没有出厂 profile；先建：node bin.js rescue --from-default-profile headless --dump-config')
  } else {
    repaired = await runRung({ label: 'L1.5 出厂 rescue profile + 修复 overlay', profile: 'rescue', forcedFail: flag('--force-l15-fail') })
  }
}

// ── rung 3: the fixed guide at the fixed location ──────────────────────────
let guideWritten = false
if (ladder && !repaired && !dryRun) {
  try {
    console.log(execFileSync(NODE, [GUIDE_WRITER, '--incident', incident], { encoding: 'utf8' }).trim())
    guideWritten = true
  } catch (error) {
    console.error(`[repair] 写通用说明失败：${String(error.stdout ?? error.message).slice(0, 200)}`)
  }
}

// ── final record ───────────────────────────────────────────────────────────
writeLadder(guideWritten ? '已收尾：写通用说明' : '已收尾')
const sessions = existsSync(SESSIONS)
  ? readdirSync(SESSIONS, { withFileTypes: true }).filter((e) => e.isDirectory())
    .flatMap((e) => readdirSync(`${SESSIONS}\\${e.name}`, { withFileTypes: true })
      .filter((s) => s.isDirectory())
      .map((s) => `${SESSIONS}\\${e.name}\\${s.name}`))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  : undefined

console.log(`\n[repair] 阶梯：${rungs.map((r) => `${r.label}=${r.verdict}`).join(' → ')}`)
console.log(`[repair] 修复报告：${existsSync(reportPath) ? reportPath : '未生成（视为 NEEDS-HUMAN）'}`)
console.log(`[repair] 分级判定：${incident}\\ladder.md`)
if (sessions !== undefined) console.log(`[repair] 完整修复会话记录：${sessions}（session.v3.jsonl.zstd）`)
if (guideWritten) console.log('[repair] 通用说明：D:\\dsh\\HOST-DOWN-README.md')
process.exit(repaired ? 0 : 3)
