/**
 * incident-repair.mjs — the repair LADDER: L1 (headless + repair overlay) →
 * L1.5 (factory `rescue` profile, same overlay) → fixed-位置 general guide.
 *
 * Each rung runs AT MOST ONCE per invocation (the supervisor additionally caps how
 * often it may call this file). A rung is escalated past when its process fails OR
 * its output carries a boot-failure signature — a repair agent that cannot even boot
 * is exactly the case the next rung exists for.
 *
 * Isolation note: rung 1 uses `--profile headless` (no local plugins, no UI rows) and
 * rung 2 uses `--profile rescue` (created from the shipped template, so a broken
 * `$DSH_HOME` overlay or a broken profile tree cannot follow it there). Neither rung
 * passes `--patch $DSH_HOME/cordis.patch.yml`.
 *
 * Usage:
 *   node incident-repair.mjs [--incident <dir>] [--prompt <file>] [--timeout-mins 10]
 *                            [--no-ladder] [--dry-run]
 *   test-only: --force-l1-fail  --force-l15-fail     (skip a rung without calling a model)
 * Exit: 0 = some rung ran, 2 = setup problem, 3 = every rung failed (guide written).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

const NODE = 'D:\\dsh\\runtime\\node\\node.exe'
const BIN = 'D:\\dsh\\runtime\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const HOME = 'D:\\dsh\\home'
const INCIDENTS = 'D:\\dsh\\state\\incidents'
const OVERLAY = 'D:\\dsh\\config\\repair\\repair-overlay.yml'
const PROMPT_FILE = 'D:\\dsh\\config\\repair\\repair-prompt.md'
const GUIDE_WRITER = 'D:\\dsh\\config\\write-host-down-readme.mjs'

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

/** A rung's process failed, or its output carries a boot-failure signature. */
const BOOT_FAIL = /plugin tree failed to load|failed to apply loader entry|unknown config key|ERR_MODULE_NOT_FOUND|Cannot find (module|package)|EADDRINUSE|bad option/iu

/**
 * Run one rung. ONE array is used for the printed command and the executed one — the
 * first version printed a correct command and executed a broken one, so this asserts
 * the shape before running.
 */
function runRung({ label, profile, forcedFail }) {
  const dshArgs = [BIN, '--profile', profile, '--patch', OVERLAY, 'headless', task]
  const printable = `${NODE} ${BIN} --profile ${profile} --patch ${OVERLAY} headless "<${task.length} 字符任务>"`
  if (dshArgs[0] !== BIN || dshArgs[1] !== '--profile' || dshArgs[3] !== '--patch') {
    console.error('incident-repair: 内部断言失败：执行参数与预期形状不一致')
    process.exit(2)
  }
  console.log(`[repair] ${label}：${printable}`)
  console.log(`[repair] ${label}：DSH_HOME=${HOME}（显式传递；不传 CLI 会回落到默认 home）`)
  if (forcedFail === true) return { ok: false, bootFailure: true, out: '(test-only forced failure)', code: 'forced' }
  if (dryRun) return { ok: true, bootFailure: false, out: '(dry-run)', code: 'dry-run' }
  try {
    // DSH_HOME must be handed over explicitly. The supervisor is started by the launcher, whose
    // environment carries no DSH_HOME, so the CLI fell back to the DEFAULT home
    // (C:\Users\ASUS\.dsh): the ladder loaded ANOTHER installation's headless profile
    // ("profile rescue does not exist" + a permission-preset refusal) while the sandbox write
    // boundary still pointed at D:\dsh\home. Measured in the 2026-09-27 live-fire test.
    const out = execFileSync(NODE, dshArgs, {
      cwd: HOME,
      env: { ...process.env, DSH_HOME: HOME },
      encoding: 'utf8',
      timeout: timeoutMins * 60 * 1000,
      maxBuffer: 64 * 1024 * 1024,
    })
    return { ok: true, bootFailure: BOOT_FAIL.test(out), out, code: 0 }
  } catch (error) {
    const out = `${error.stdout ?? ''}${error.stderr ?? ''}${String(error.message)}`
    return { ok: false, bootFailure: BOOT_FAIL.test(out), out, code: error.status ?? null }
  }
}

const rungs = []
const record = (label, r) => {
  rungs.push({ label, ok: r.ok, bootFailure: r.bootFailure, code: r.code })
  writeFileSync(`${incident}\\repair-agent-output-${rungs.length}.txt`, r.out, 'utf8')
  console.log(`[repair] ${label} → ${r.ok ? 'ok' : `failed(exit=${r.code})`}${r.bootFailure ? '，且判定为"起不来"' : ''}；输出 ${r.out.length} 字符`)
}

// ── rung 1: L1 ─────────────────────────────────────────────────────────────
const rung1 = runRung({ label: 'L1 headless + 修复 overlay', profile: 'headless', forcedFail: flag('--force-l1-fail') })
record('L1', rung1)
let report = `${incident}\\repair-report.md`
let escalated = !rung1.ok || rung1.bootFailure

// ── rung 2: L1.5 factory profile ───────────────────────────────────────────
if (ladder && escalated) {
  const rescueDir = `${HOME}\\profiles\\rescue`
  if (!existsSync(rescueDir)) {
    rungs.push({ label: 'L1.5 rescue', ok: false, bootFailure: false, code: 'missing-profile' })
    console.log('[repair] L1.5：没有出厂 profile；先建：node bin.js rescue --from-default-profile headless --dump-config')
  } else {
    const rung2 = runRung({ label: 'L1.5 出厂 rescue profile + 修复 overlay', profile: 'rescue', forcedFail: flag('--force-l15-fail') })
    record('L1.5', rung2)
    escalated = !rung2.ok || rung2.bootFailure
  }
}

// ── rung 3: the fixed guide at the fixed location ──────────────────────────
let guideWritten = false
if (ladder && escalated && !dryRun) {
  try {
    const out = execFileSync(NODE, [GUIDE_WRITER, '--incident', incident], { encoding: 'utf8' })
    console.log(out.trim())
    guideWritten = true
  } catch (error) {
    console.error(`[repair] 写通用说明失败：${String(error.stdout ?? error.message).slice(0, 200)}`)
  }
}

const ladderText = [
  `# 修复阶梯结果 ${new Date().toISOString()}`,
  '',
  '| 级 | 结果 | 退出码 | 判定 |',
  '| --- | --- | --- | --- |',
  ...rungs.map((r) => `| ${r.label} | ${r.ok ? 'ok' : 'failed'} | ${r.code} | ${r.bootFailure ? '起不来' : '—'} |`),
  '',
  `- 代理报告：${existsSync(report) ? report : '未生成'}`,
  `- 通用说明：${guideWritten ? 'D:\\dsh\\HOST-DOWN-README.md（已写）' : '未写'}`,
  ''
].join('\n')
writeFileSync(`${incident}\\ladder.md`, ladderText, 'utf8')

console.log(`[repair] 阶梯：${rungs.map((r) => `${r.label}=${r.ok ? 'ok' : 'fail'}`).join(' → ')}`)
if (existsSync(report)) {
  const text = readFileSync(report, 'utf8')
  console.log(`[repair] 报告结论：${/READY-TO-RESTART/u.test(text) ? 'READY-TO-RESTART' : (/NEEDS-HUMAN/u.test(text) ? 'NEEDS-HUMAN' : '（无明确结论）')}`)
} else {
  console.log('[repair] 未生成 repair-report.md（视为 NEEDS-HUMAN）')
}
console.log(`[repair] 明细：${incident}\\ladder.md`)
process.exit(escalated ? 3 : 0)
