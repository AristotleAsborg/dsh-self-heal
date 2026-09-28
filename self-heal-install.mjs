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
import { fileURLToPath } from 'node:url'

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
// The kit's own directory, derived from this module's URL.
// WHY fileURLToPath AND NOT `.pathname`: `pathname` is PERCENT-ENCODED and keeps a leading
// slash, so a kit checked out under a path containing a space produced
// `D:\deepseek%20harness\self-heal-kit` and every copyFileSync below died with
// ENOENT ... 'D:\deepseek%20harness\self-heal-kit\start-gate.mjs'. fileURLToPath decodes the
// percent-escapes and yields a native path. Measured 2026-09-27: the untouched installer
// failed exactly this way from D:\deepseek harness\self-heal-kit.
const SRC = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/u, '')
const dryRun = argv.includes('--dry-run')
// Skip the two steps that need a real dsh CLI (factory `rescue` profile + gate verification).
// WHY IT EXISTS: those steps cannot run on a machine that only has the kit — a CI runner, or a
// "copy the files now, run the CLI later" install. Without this the installer could not be
// exercised end-to-end anywhere except a full DSH box, which is precisely how the path/`%20`
// and missing-`repair\` bugs survived: nothing ever ran it on a clean layout.
const noVerify = argv.includes('--no-verify')
const BEGIN = 'REM === dsh-self-heal BEGIN ==='
const END = 'REM === dsh-self-heal END ==='

const say = (s) => console.log(s)
const toCRLF = (text) => text.replace(/\r?\n/gu, '\r\n')
const lfOnly = (text) => (text.match(/(?<!\r)\n/gu) ?? []).length

/**
 * Record a delivery failure. A missing piece of the kit used to be reported only as a log line
 * while the installer still exited 0 and printed "完成" — a success report for an install that
 * cannot work. Failures now decide the exit code.
 */
const problems = []
const fail = (msg) => { problems.push(msg); say(`[FAIL] ${msg}`) }

function block(indent = '') {
  return [
    BEGIN,
    'REM  Startup gate + crash supervisor + L1 repair ladder. Remove this block to detach the kit.',
    `set "DSH_NODE=${NODE}"`,
    'REM  L1 repair ladder ON by default; opt out with: set DSH_NO_REPAIR_AGENT=1',
    'set "DSH_SUPERVISOR_REPAIR_AGENT=1"',
    'if defined DSH_NO_REPAIR_AGENT set "DSH_SUPERVISOR_REPAIR_AGENT="',
    'REM  Relaunch after a VERIFIED repair is ON by default: once the boot probe (or a confirmed',
    'REM  resync) proves the host can start, leaving it down helps nobody. Bounded to one relaunch per',
    'REM  cooldown window by the supervisor, so this cannot become a crash loop.',
    'REM  Opt out with: set DSH_NO_RELAUNCH=1',
    'set "DSH_SUPERVISOR_RELAUNCH=1"',
    'if defined DSH_NO_RELAUNCH set "DSH_SUPERVISOR_RELAUNCH="',
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
  if (!/(start-dsh\.ps1|dsh\\lib\\bin\.js)/u.test(original)) {
    say('[wire] 启动器不像 DSH 启动器 → 不擅自修改，改用包装脚本')
    return writeWrapper()
  }
  const lines = original.split(/\r?\n/u)
  const isComment = (l) => /^\s*(REM\b|::)/iu.test(l)
  // Every line this installer injects into the launch tail, whoever wrote it.
  // WHY SO NARROW: two earlier, looser predicates each broke idempotency in a different way.
  // Matching only our canonical string missed a hand-written `%~dp0config\host-supervisor.mjs`
  // call; matching `--exit-code` alone missed the 3 companion lines (a "keep the window" REM and
  // two DSH_NO_PAUSE lines) so each run ADDED three without removing any; matching any
  // DSH_NO_PAUSE line also caught the launcher's OWN `:gate_refused` pause, so each run REMOVED
  // a user line too — the file oscillated 135 <-> 158 lines with period 2 (the build never
  // converged, which also means "all checks passed" would only ever have covered one phase).
  // So: match the launch tail op by op, each tied to something only this installer writes.
  const isSupervisorCall = (l) => {
    if (isComment(l)) return /窗口留住/u.test(l)
    if (/host-supervisor\.mjs/u.test(l) && /--exit-code/u.test(l)) return true
    return /%CODE%/u.test(l) && /DSH_NO_PAUSE/u.test(l) && /(pause|echo)/u.test(l)
  }

  // Inject at the line that actually INVOKES start-dsh.ps1.
  // WHY NOT `lines.findIndex((l) => /start-dsh\.ps1/.test(l))`: that also matches prose. The
  // real launcher carries `REM  start-dsh.ps1 next to this file).` near the top, so the first
  // "match" was a COMMENT and every install inserted another block there.
  // Measured 2026-09-27: three runs took the launcher 135 -> 159 -> 183 -> 207 lines, with 3
  // BEGIN blocks and 4 `chcp` lines. A deploy script must stay idempotent even against a
  // hand-edited launcher, so: skip comments, collapse, and rebuild rather than append.

  // Collapse: drop every existing marked block, then every supervisor call. What remains is the
  // user's own launcher; exactly one block and one supervisor call are re-injected below.
  const collapsed = []
  let insideBlock = false
  for (const line of lines) {
    if (line.trim() === BEGIN) { insideBlock = true; continue }
    if (line.trim() === END) { insideBlock = false; continue }
    if (insideBlock) continue
    if (isSupervisorCall(line)) continue
    collapsed.push(line)
  }
  // Idempotency is judged by the SHAPE of the file, not by "did the collapse remove anything".
  // Those are not the same question: a correctly wired launcher ALWAYS has its block and its
  // supervisor call inside the collapse set, so `collapsed.length === lines.length` can never
  // hold and the guard could never fire — the installer rewrote an already-correct launcher on
  // every run (measured 2026-09-27). Count the parts instead: exactly one marked block, exactly
  // one supervisor call, exactly one keep-the-window group.
  //
  // BUT SHAPE ALONE IS NOT ENOUGH, and that bug was measured too: after `block()` gained the
  // relaunch defaults, every launcher still passed the shape test, so the guard reported
  // "idempotent, no change" and the new lines were NEVER INSTALLED. A guard that asks "does a block
  // exist?" instead of "is the block CURRENT?" freezes the launcher at whatever it had the first
  // time. So also compare the existing block's CONTENT against the block we would write now, and
  // rewrite when they differ.
  const countOf = (re) => (original.match(re) ?? []).length
  const isCleanShape = countOf(/dsh-self-heal BEGIN/gu) === 1
    && countOf(/dsh-self-heal END/gu) === 1
    && countOf(/^.*host-supervisor\.mjs.*--exit-code.*$/gmu) === 1
    && countOf(/窗口留住/gu) === 1
  const existingBlock = (() => {
    const a = lines.findIndex((l) => l.trim() === BEGIN)
    const b = lines.findIndex((l) => l.trim() === END)
    if (a < 0 || b < a) return undefined
    return lines.slice(a + 1, b).map((l) => l.trim()).join('\n')
  })()
  const desiredBlock = block().split('\r\n').slice(1, -1).map((l) => l.trim()).join('\n')
  const blockIsCurrent = existingBlock !== undefined && existingBlock === desiredBlock
  if (isCleanShape && blockIsCurrent) { say('[wire] 启动器已接线且无重复（幂等，不改动）'); return true }
  if (isCleanShape && !blockIsCurrent) say('[wire] 接线块内容已过期（缺少新开关）→ 重写该块')
  copyFileSync(LAUNCHER, `${LAUNCHER}.bak-selfheal-${new Date().toISOString().replace(/[-:T]/gu, '').slice(0, 14)}`)
  const at = collapsed.findIndex((l) => !isComment(l) && /start-dsh\.ps1/u.test(l))
  const out = []
  for (let i = 0; i < collapsed.length; i += 1) {
    if (i === at && at >= 0) out.push(block())
    out.push(collapsed[i])
    if (at >= 0 && i === at + 1 && /^set "CODE=/u.test(collapsed[i].trim())) {
      out.push(SUPERVISOR_CALL)
      out.push('REM  窗口留住，好让 L1 的进度和事故目录被看见（DSH_NO_PAUSE=1 可关）')
      out.push('if not "%CODE%"=="0" if not defined DSH_NO_PAUSE echo.& echo [dsh] 按任意键关闭此窗口 ...')
      out.push('if not "%CODE%"=="0" if not defined DSH_NO_PAUSE pause >nul')
    }
  }
  writeCRLF(LAUNCHER, out.join('\r\n'))
  const removed = lines.length - collapsed.length
  if (removed > 0) say(`[wire] 已折叠重复接线（去掉 ${removed} 行；${lines.length} → ${out.length} 行，BEGIN 块与 supervisor 调用各只保留 1 份）`)
  else say(`[wire] 已接线（${lines.length} → ${out.length} 行）`)
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
  // `profile` and `port` are read from the EXISTING config first, because they are exactly the kind
  // of thing a deployment changes and the installer has no way to guess: a run on a machine using
  // profile `tui` on port 4090 used to stamp `profile: 'web', port: 3080` over it, and every script
  // that composes or probes a profile would then have watched the wrong one — silently, since the
  // values are perfectly valid. `--profile` / `--port` override explicitly when given.
  let previous = {}
  if (existsSync(CONFIG)) {
    try { previous = JSON.parse(readFileSync(CONFIG, 'utf8')) } catch { previous = {} }
  }
  if (typeof previous !== 'object' || previous === null || Array.isArray(previous)) previous = {}
  const PROFILE = opt('--profile', previous.profile ?? 'web')
  // The CLI reserves the `desktop` profile for the Electron app and rejects every command that names it:
  //   error: profile "desktop" is managed exclusively by the Electron application
  // This kit drives the CLI (gate composes the tree, supervisor re-checks it, the ladder probes it), so a
  // `desktop` profile would make every one of those calls fail with that message. Refuse it here, at
  // install time, where the fix is obvious — rather than letting it surface later as a CLI error from a
  // script the operator did not invoke by hand.
  if (PROFILE.toLowerCase() === 'desktop') {
    say('[FAIL] profile "desktop" 由 Electron 桌面端独占，CLI 会拒绝一切指名它的命令；本套件驱动 CLI，无法使用它。')
    say('       请指向你的 CLI profile（默认 web）。桌面端与本套件是两套独立生命周期。')
    problems.push('profile "desktop" is reserved for the Electron desktop app')
    // Fail FAST: do not write a config naming a profile every later call will be rejected for. Writing it
    // and then reporting failure leaves a half-installed harness whose gate can never pass.
    return
  }
  const PORT = Number(opt('--port', String(previous.port ?? 3080)))
  const PROBE_PORT = Number(opt('--probe-port', String(previous.probePort ?? PORT + 1)))
  // `state` / `incidents` / `log` follow the SAME rule as profile/port: they are exactly the kind of
  // thing a deployment moves, and guessing wrong is silent. They used to be re-derived from HOME on
  // every run, which quietly broke a deployment whose incidents live outside $DSH_HOME — measured
  // 2026-09-27: a machine keeping 13 incident packages in <harness>\state got a config naming
  // <home>\state\incidents, so its next crash landed in a different root from every previous one, and
  // the two never rejoined. NOTE the old shape was worse than a plain override: `state` was in the
  // preserved set while `incidents` was owned, so the two keys could disagree with each other.
  const STATE_ROOT = opt('--state', previous.state ?? `${HOME}\\state`)
  const config = {
    node: NODE, bin: `${HARNESS}\\runtime\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`,
    home: HOME, profile: PROFILE, port: PORT, probePort: PROBE_PORT,
    state: STATE_ROOT,
    log: opt('--log', previous.log ?? `${HARNESS}\\dsh-console.log`),
    // Kept in step with `state`, so the default still follows it; an explicit value wins.
    incidents: opt('--incidents', previous.incidents ?? `${STATE_ROOT}\\incidents`),
    promptFile: `${HARNESS}\\config\\repair\\repair-prompt.md`,
    overlay: `${HARNESS}\\config\\repair\\repair-overlay.yml`,
    launcher: LAUNCHER,
  }
  if (dryRun) { say(`[dry-run] 将写 ${CONFIG}（profile=${PROFILE} port=${PORT} probePort=${PROBE_PORT} state=${STATE_ROOT}）`); return }
  // MERGE, do not clobber. This file is explicitly documented as the one place a deployment
  // records where things live, and self-heal.config.mjs reads keys beyond this list (state,
  // attempts, gate, supervisor, ladder, guide, fixed, and the timeouts). Replacing the whole
  // file silently deleted any such key on every re-install — measured 2026-09-27: a `state`
  // key added by hand was gone after one install run, with no warning. Keys this function owns
  // are refreshed; everything else the deployment set is preserved and reported.
  const preserved = Object.keys(previous).filter((k) => !Object.hasOwn(config, k))
  const merged = { ...previous, ...config }
  mkdirSync(`${HARNESS}\\config`, { recursive: true })
  writeFileSync(CONFIG, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  say(`[config] 已写 ${CONFIG}（脚本从这里取路径，不再硬编码；profile=${PROFILE} port=${PORT}）`)
  if (preserved.length > 0) say(`[config] 保留了你自定义的键：${preserved.join(', ')}`)
}

function copyKit() {
  // EXPLICIT list. A wildcard here would ship every unrelated .mjs that happens to sit in the
  // same directory (85 files in this checkout) — the kit is exactly these.
  // gate-parse.mjs is here because start-gate.mjs imports it; leaving it out would produce a gate
  // that cannot start, while every file that IS copied still looked fine. The manifest verifier
  // fails if this list and the directory ever drift apart.
  const files = ['start-gate.mjs', 'gate-parse.mjs', 'host-supervisor.mjs', 'incident-repair.mjs', 'write-host-down-readme.mjs', 'self-heal.config.mjs', 'self-heal-install.mjs']
  // The repair/ directory is NOT optional, even though nothing imports it: writeConfig points
  // `promptFile` and `overlay` at these files, and incident-repair.mjs hard-exits (code 2) when
  // either is missing. This function copied only the .mjs files, so a fresh install produced a
  // config naming two files that were never placed — the repair ladder could not start at all.
  // The second .mjs list is the kit's own manifest; keep the two in step.
  const repairFiles = ['repair-prompt.md', 'repair-overlay.yml', 'HOST-DOWN-README.md', 'plumbing-test-prompt.md']
  const sameDir = SRC.toLowerCase() === `${HARNESS}\\config`.toLowerCase()
  let copied = 0
  for (const f of files) {
    if (sameDir) { say(`[copy] 已在目标目录：${f}`); continue }
    if (dryRun) { say(`[dry-run] 将复制 ${f}`); continue }
    copyFileSync(`${SRC}\\${f}`, `${HARNESS}\\config\\${f}`)
    copied += 1
  }
  const repairDest = `${HARNESS}\\config\\repair`
  if (!sameDir) {
    if (dryRun) say(`[dry-run] 将复制 repair\\ 下 ${repairFiles.length} 个文件`)
    else {
      mkdirSync(repairDest, { recursive: true })
      for (const f of repairFiles) {
        if (!existsSync(`${SRC}\\repair\\${f}`)) { say(`[copy] 警告：套件里缺少 repair\\${f}`); continue }
        copyFileSync(`${SRC}\\repair\\${f}`, `${repairDest}\\${f}`)
        copied += 1
      }
    }
  } else {
    say('[copy] 已在目标目录（config\\repair 就地生效）')
  }
  const total = files.length + repairFiles.length
  say(`[copy] 套件文件 ${copied}/${total} 个${dryRun ? '（dry-run）' : ''}`)
  // Prove the two paths the config just declared actually exist. Without this the install can
  // "succeed" while the ladder is dead on arrival.
  for (const [label, path] of [['repair-prompt.md', `${repairDest}\\repair-prompt.md`], ['repair-overlay.yml', `${repairDest}\\repair-overlay.yml`]]) {
    if (!existsSync(path)) fail(`缺少 ${label}：${path}（L1 修复阶梯将无法启动）`)
  }
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
    say(`接线块    ${text.includes(BEGIN) ? '有' : '无'}；L1 默认开启 ${/DSH_SUPERVISOR_REPAIR_AGENT=1/u.test(text) ? '有' : '无'}；修复后自动重启默认开启 ${/DSH_SUPERVISOR_RELAUNCH=1/u.test(text) ? '有' : '无'}；CRLF=${(text.match(/\r\n/gu) ?? []).length} LF-only=${lfOnly(text)}`)
  }
  for (const f of ['start-gate.mjs', 'host-supervisor.mjs', 'incident-repair.mjs', 'write-host-down-readme.mjs', 'self-heal.config.mjs']) {
    say(`套件文件  ${f} ${existsSync(`${HARNESS}\\config\\${f}`) ? '有' : '缺'}`)
  }
  for (const f of ['repair-prompt.md', 'repair-overlay.yml', 'HOST-DOWN-README.md']) {
    say(`修复契约  ${f} ${existsSync(`${HARNESS}\\config\\repair\\${f}`) ? '有' : '缺'}`)
  }
  say(`出厂档    ${existsSync(`${HOME}\\profiles\\rescue`) ? '有' : '缺'}`)
}

function uninstall() {
  const text = readLauncher()
  if (text !== undefined && text.includes(BEGIN)) {
    copyFileSync(LAUNCHER, `${LAUNCHER}.bak-selfheal-uninstall-${Date.now()}`)
    const kept = text.split(/\r?\n/u).filter((l) => l !== BEGIN && l !== END && !l.includes('DSH_SUPERVISOR_REPAIR_AGENT') && !l.includes('DSH_NO_REPAIR_AGENT') && !l.includes('DSH_SUPERVISOR_RELAUNCH') && !l.includes('DSH_NO_RELAUNCH') && !l.includes('dsh_self_heal') && !l.includes(SUPERVISOR_CALL) && !l.startsWith('set "DSH_NODE='))
    writeCRLF(LAUNCHER, kept.join('\r\n'))
    say('[uninstall] 启动器接线已移除（原文有备份）')
  } else { say('[uninstall] 启动器里没有接线块') }
  say('[uninstall] 套件文件保留（--keep-files 之外的删除属于不可逆操作，由你手动做）')
}

if (command === 'install') {
  writeConfig(); copyKit(); wireLauncher()
  if (noVerify) {
    say('[skip] --no-verify：跳过出厂 profile 与闸门复验（需要真实 dsh CLI）')
  } else {
    rescueProfile(); verifyGate()
  }
  if (problems.length > 0) {
    say(`\n安装未完成：${problems.length} 项失败。修好上面 [FAIL] 的项后重跑；不要以为已经装好了。`)
    process.exit(1)
  }
  say('\n完成。启动方式：双击 ' + (existsSync(`${HARNESS}\\start-dsh-self-heal.cmd`) ? 'start-dsh-self-heal.cmd' : LAUNCHER.split('\\').pop()))
  if (noVerify) say('提示：还没跑闸门复验。在有 dsh CLI 的机器上重跑一次不带 --no-verify 的 install 即可验证。')
} else if (command === 'uninstall') uninstall()
else check()
