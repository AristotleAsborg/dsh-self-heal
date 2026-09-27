/**
 * self-heal-install.mjs — option-A installer for the kit.
 *
 *   node self-heal-install.mjs check      [--harness <dir>] [--home <dir>]
 *   node self-heal-install.mjs install    [--harness <dir>] [--home <dir>] [--launcher <file>] [--node <exe>] [--dry-run]
 *   node self-heal-install.mjs uninstall  [--launcher <file>] [--keep-files]
 *
 * install writes <harness>\config\self-heal.config.json (so the scripts stop carrying hardcoded
 * paths), copies the kit next to it, wires the LAUNCHER so a plain `start-dsh.cmd` wakes the L1
 * repair ladder (CRLF-only, idempotent, backed up), creates the factory fallback profile, and
 * then runs the gate to prove the result.
 *
 * The launcher edit is deliberately conservative:
 *   - a marked block  `REM === dsh-self-heal BEGIN/END ===` is replaced if present (idempotent);
 *   - otherwise the block is inserted before the launcher's `powershell ... start-dsh.ps1` line
 *     when that line exists, and the exit-code handling after it is extended;
 *   - if the launcher does not look like a DSH launcher, nothing is touched and a wrapper
 *     `start-dsh-self-heal.cmd` is written instead, so L1 is still reachable by double-click.
 * Every write is CRLF-only and verified afterwards: cmd.exe mis-parses LF-only .cmd files once
 * they contain goto labels or multi-line blocks.
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const command = argv[0] ?? 'check'
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const HARNESS = opt('--harness', process.env.DSH_SELFHEAL_HARNESS ?? 'D:\\dsh')
const HOME = opt('--home', process.env.DSH_HOME ?? `${HARNESS}\\home`)
const NODE = opt('--node', `${HARNESS}\\runtime\\node\\node.exe`)
const LAUNCHER = opt('--launcher', `${HARNESS}\\start-dsh.cmd`)
const CONFIG = `${HARNESS}\\config\\self-heal.config.json`
const SRC = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/u, '$1').replace(/\//gu, '\\')
const dryRun = argv.includes('--dry-run')
const BEGIN = 'REM === dsh-self-heal BEGIN ==='
const END = 'REM === dsh-self-heal END ==='

const say = (s) => console.log(s)
const toCRLF = (text) => text.replace(/\r?\n/gu, '\r\n')
const lfOnly = (text) => (text.match(/(?<!\r)\n/gu) ?? []).length

function block(indent = '') {
  return [
    BEGIN,
    'REM  Startup gate + crash supervisor + L1 repair ladder. Remove this block to detach the kit.',
    `set "DSH_NODE=${NODE}"`,
    'REM  L1 repair ladder ON by default; opt out with: set DSH_NO_REPAIR_AGENT=1',
    'set "DSH_SUPERVISOR_REPAIR_AGENT=1"',
    'if defined DSH_NO_REPAIR_AGENT set "DSH_SUPERVISOR_REPAIR_AGENT="',
    'set "DSH_GATE_ONLY="',
    'if /i "%~1"=="-GateOnly" set "DSH_GATE_ONLY=1"',
    'if defined DSH_SKIP_GATE goto :dsh_self_heal_launch',
    `if not exist "${HARNESS}\\config\\start-gate.mjs" goto :dsh_self_heal_launch`,
    'REM  UTF-8 before the gate: cmd starts at the ANSI code page and would mangle the gate output.',
    'chcp 65001 >nul',
    '"%DSH_NODE%" "' + HARNESS + '\\config\\start-gate.mjs"',
    'if errorlevel 1 goto :dsh_self_heal_refused',
    'if defined DSH_GATE_ONLY ( echo [dsh] startup gate passed; -GateOnly given, so the host was not started. & exit /b 0 )',
    'goto :dsh_self_heal_launch',
    ':dsh_self_heal_refused',
    'echo.',
    'echo [dsh] startup gate REFUSED to launch. Fix the item reported above, or bypass once with:',
    'echo         set DSH_SKIP_GATE=1',
    'if not defined DSH_NO_PAUSE pause',
    'exit /b 1',
    ':dsh_self_heal_launch',
    END,
  ].map((l) => indent + l).join('\r\n')
}

const SUPERVISOR_CALL = `if not "%CODE%"=="0" if not "%CODE%"=="" if exist "${HARNESS}\\config\\host-supervisor.mjs" "%DSH_NODE%" "${HARNESS}\\config\\host-supervisor.mjs" --exit-code %CODE% --repair`

function readLauncher() {
  if (!existsSync(LAUNCHER)) return undefined
  return readFileSync(LAUNCHER, 'utf8')
}

function wireLauncher() {
  const original = readLauncher()
  if (original === undefined) { say(`[wire] 找不到启动器 ${LAUNCHER} → 改用包装脚本`); return writeWrapper() }
  const alreadyWired = original.includes(BEGIN) && original.includes(SUPERVISOR_CALL)
  if (alreadyWired) { say('[wire] 启动器已接线（幂等，不改动）'); return true }
  if (!/(start-dsh\.ps1|dsh\\lib\\bin\.js)/u.test(original)) {
    say('[wire] 启动器不像 DSH 启动器 → 不擅自修改，改用包装脚本')
    return writeWrapper()
  }
  copyFileSync(LAUNCHER, `${LAUNCHER}.bak-selfheal-${new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)}`)
  const lines = original.split(/\r?\n/u)
  const launchAt = lines.findIndex((l) => /start-dsh\.ps1/u.test(l))
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    if (i === launchAt) out.push(block())
    if (lines[i].includes(SUPERVISOR_CALL)) continue
    out.push(lines[i])
    if (i === launchAt + 1 && /^set "CODE=/u.test(lines[i].trim())) {
      out.push(SUPERVISOR_CALL)
      out.push('REM  窗口留住，好让 L1 的进度和事故目录被看见（DSH_NO_PAUSE=1 可关）')
      out.push('if not "%CODE%"=="0" if not defined DSH_NO_PAUSE echo.& echo [dsh] 按任意键关闭此窗口 ...')
      out.push('if not "%CODE%"=="0" if not defined DSH_NO_PAUSE pause >nul')
    }
  }
  writeCRLF(LAUNCHER, out.join('\r\n'))
  return true
}

function writeWrapper() {
  const path = `${HARNESS}\\start-dsh-self-heal.cmd`
  writeCRLF(path, [
    '@echo off',
    'REM  Wrapper written by self-heal-install.mjs: leaves your own launcher untouched and still',
    'REM  wakes the gate, the supervisor and the L1 repair ladder.',
    block(),
    'call "' + LAUNCHER + '" %*',
    'exit /b %ERRORLEVEL%',
  ].join('\r\n'))
  say(`[wire] 已写包装脚本：${path}（双击它启动即可）`)
  return true
}

function writeCRLF(path, text) {
  if (dryRun) { say(`[dry-run] 将写 ${path}（${text.length} 字节）`); return }
  writeFileSync(path, toCRLF(text), 'utf8')
  const after = readFileSync(path, 'utf8')
  const bad = lfOnly(after)
  say(`[write] ${path}  CRLF=${(after.match(/\r\n/gu) ?? []).length}  LF-only=${bad}${bad === 0 ? '' : ' ← 需要修'}`)
  if (bad !== 0) process.exit(1)
}

function writeConfig() {
  const config = {
    node: NODE, bin: `${HARNESS}\\runtime\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
    home: HOME, profile: 'web', port: 3080, probePort: 3081,
    log: `${HARNESS}\\dsh-console.log`, incidents: `${HOME}\\state\\incidents`,
    promptFile: `${HARNESS}\\config\\repair\\repair-prompt.md`,
    overlay: `${HARNESS}\\config\\repair\\repair-overlay.yml`,
    launcher: LAUNCHER,
  }
  if (dryRun) { say('[dry-run] 将写 ' + CONFIG); return }
  mkdirSync(`${HARNESS}\\config`, { recursive: true })
  writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  say(`[config] 已写 ${CONFIG}（脚本从这里取路径，不再硬编码）`)
}

function copyKit() {
  // EXPLICIT list. A wildcard here would ship every unrelated .mjs that happens to sit in the
  // same directory (85 files in this checkout) — the kit is exactly these five.
  const files = ['start-gate.mjs', 'host-supervisor.mjs', 'incident-repair.mjs', 'write-host-down-readme.mjs', 'self-heal.config.mjs', 'self-heal-install.mjs']
  for (const f of files) {
    if (SRC.toLowerCase() === `${HARNESS}\\config`.toLowerCase()) { say(`[copy] 已在目标目录：${f}`); continue }
    if (dryRun) { say(`[dry-run] 将复制 ${f}`); continue }
    copyFileSync(`${SRC}\\${f}`, `${HARNESS}\\config\\${f}`)
  }
  say(`[copy] 套件文件 ${files.length} 个`)
}

function rescueProfile() {
  const dir = `${HOME}\\profiles\\rescue`
  if (existsSync(dir)) { say('[rescue] 出厂 profile 已存在'); return }
  if (dryRun) { say('[dry-run] 将创建出厂 rescue profile'); return }
  try {
    execFileSync(NODE, [`${HARNESS}\\runtime\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`, 'rescue', '--from-default-profile', 'headless', '--dump-config'],
      { env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8' })
    say('[rescue] 已创建（只创建不启动）')
  } catch (error) {
    say('[rescue] 创建失败：' + String(error.message).slice(0, 120))
  }
}

function verifyGate() {
  if (dryRun) { say('[verify] dry-run 跳过'); return }
  try {
    const out = execFileSync(NODE, [`${HARNESS}\\config\\start-gate.mjs`], { encoding: 'utf8', env: { ...process.env, DSH_HOME: HOME } })
    say('[verify] 闸门：PASS（组合树可解析，未见确证不一致）')
    for (const l of out.split('\n').filter((x) => x.includes('[FAIL]'))) say('        ' + l.trim())
  } catch (error) {
    say('[verify] 闸门：REFUSED 或调用失败 → ' + String(error.stdout ?? error.message).split('\n').filter((l) => l.includes('[')).slice(0, 4).join(' | '))
  }
}

function check() {
  say(`harness   ${HARNESS}`)
  say(`home      ${HOME}`)
  say(`launcher  ${LAUNCHER}${existsSync(LAUNCHER) ? '' : '（不存在）'}`)
  say(`config    ${CONFIG}${existsSync(CONFIG) ? '' : '（未安装）'}`)
  const text = readLauncher()
  if (text !== undefined) {
    say(`接线块    ${text.includes(BEGIN) ? '有' : '无'}；L1 默认开启 ${/DSH_SUPERVISOR_REPAIR_AGENT=1/u.test(text) ? '有' : '无'}；CRLF=${(text.match(/\r\n/gu) ?? []).length} LF-only=${lfOnly(text)}`)
  }
  for (const f of ['start-gate.mjs', 'host-supervisor.mjs', 'incident-repair.mjs', 'write-host-down-readme.mjs', 'self-heal.config.mjs']) {
    say(`套件文件  ${f} ${existsSync(`${HARNESS}\\config\\${f}`) ? '有' : '缺'}`)
  }
  say(`出厂档    ${existsSync(`${HOME}\\profiles\\rescue`) ? '有' : '缺'}`)
}

function uninstall() {
  const text = readLauncher()
  if (text !== undefined && text.includes(BEGIN)) {
    copyFileSync(LAUNCHER, `${LAUNCHER}.bak-selfheal-uninstall-${Date.now()}`)
    const kept = text.split(/\r?\n/u).filter((l) => l !== BEGIN && l !== END && !l.includes('DSH_SUPERVISOR_REPAIR_AGENT') && !l.includes('DSH_NO_REPAIR_AGENT') && !l.includes('dsh_self_heal') && !l.includes(SUPERVISOR_CALL) && !l.startsWith('set "DSH_NODE='))
    writeCRLF(LAUNCHER, kept.join('\r\n'))
    say('[uninstall] 启动器接线已移除（原文有备份）')
  } else { say('[uninstall] 启动器里没有接线块') }
  say('[uninstall] 套件文件保留（--keep-files 之外的删除属于不可逆操作，由你手动做）')
}

if (command === 'install') { writeConfig(); copyKit(); wireLauncher(); rescueProfile(); verifyGate(); say('\n完成。启动方式：双击 ' + (existsSync(`${HARNESS}\\start-dsh-self-heal.cmd`) ? 'start-dsh-self-heal.cmd' : LAUNCHER.split('\\').pop())) }
else if (command === 'uninstall') uninstall()
else check()
