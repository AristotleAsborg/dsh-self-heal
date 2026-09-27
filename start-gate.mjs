/**
 * start-gate.mjs — L0-1 startup gate for the DSH web launcher.
 *
 * WHAT IT PROTECTS AGAINST (2026-09-27 16:39 / 16:40, twice, both fatal):
 *   mode-conduct: unknown config key "lessonsEnabled"; allowed keys are enabled, ...
 * The composed CONFIG was newer than the module the loader actually loaded, and the
 * loader treats a failing entry as fatal, so the host exited within one second of
 * launch. Both crashes would have been stopped here, before the process started.
 *
 * VERDICT DISCIPLINE:
 *   * a CONFIRMED mismatch -> refuse (exit 1) and print the exact fix command;
 *   * an internal gate error -> WARN and allow the launch (a broken gate must never
 *     be able to keep the host down), except for a composition failure, which is the
 *     very thing a boot would hit -> refuse with the bypass hint printed;
 *   * port 3080 already served by a dsh host -> WARN only (advisory, never blocks).
 * Bypass: set DSH_SKIP_GATE=1 (the launcher checks it too).
 *
 * Usage: node start-gate.mjs [--patch <extra-overlay.yml>]... [--quiet]
 * Exit:  0 = launch, 1 = refused, 2 = usage error.
 *
 * Read-only: it composes config, imports installed modules, compares bytes and reads
 * the tail of dsh-console.log. It never writes to the composition.
 */
import * as CFG from './self-heal.config.mjs'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { appendFileSync, mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const NODE = CFG.NODE
const BIN = CFG.BIN
const DSH_HOME = 'D:\\dsh\\home'
const PROFILE = `${DSH_HOME}\\profiles\\web`
const HOME_PATCH = CFG.HOME_PATCH
const LOG = CFG.LOG
const STATE = CFG.STATE
const PORT = CFG.PORT

const argv = process.argv.slice(2)
const extraPatches = []
let quiet = false
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--patch') { extraPatches.push(argv[i + 1]); i += 1 } else if (argv[i] === '--quiet') quiet = true
  else { console.error(`start-gate: unknown argument ${argv[i]}`); process.exit(2) }
}

const findings = []
const fail = (msg, fix) => findings.push({ level: 'FAIL', msg, fix })
const warn = (msg, fix) => findings.push({ level: 'WARN', msg, fix })
const pass = (msg) => findings.push({ level: 'PASS', msg })
const indentOf = (s) => ((/^(\s*)/u.exec(s) ?? ['', ''])[1]).length

/** Parse the composed dump into effective rows: last occurrence of each row id. */
function parseRows(dump) {
  const rows = new Map()
  let current = null
  for (const line of dump.split('\n')) {
    const idMatch = /^\s*-?\s*id:\s*(\S+)\s*$/u.exec(line)
    if (idMatch !== null) {
      current = { id: idMatch[1], name: undefined, config: {}, disabled: false }
      rows.set(current.id, current) // last occurrence wins: that is the effective row
      continue
    }
    if (current === null) continue
    const nameMatch = /^\s*name:\s*(\S+)\s*$/u.exec(line)
    if (nameMatch !== null && current.name === undefined) { current.name = nameMatch[1]; continue }
    if (/^\s*disabled:\s*true\s*$/u.test(line)) current.disabled = true
    // config keys: any key deeper than a preceding "config:" line
    const cfgAt = /^\s*config:\s*$/u.exec(line)
    if (cfgAt !== null) { current.configIndent = indentOf(line); continue }
    if (current.configIndent === undefined) continue
    if (line.trim() === '' || indentOf(line) <= current.configIndent) { current.configIndent = undefined; continue }
    const kv = /^\s+([A-Za-z][A-Za-z0-9]*):\s*(.*)$/u.exec(line)
    if (kv !== null) current.config[kv[1]] = kv[2].trim()
  }
  return [...rows.values()]
}

// ── 1. compose the tree exactly as the next boot will ----------------------
let dump = ''
const patchArgs = ['--profile', 'web', '--patch', HOME_PATCH]
for (const p of extraPatches) patchArgs.push('--patch', p)
try {
  dump = execFileSync(NODE, [BIN, ...patchArgs, '--dump-config'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  pass('组合树可解析（dump-config 成功）')
} catch (error) {
  fail(`组合失败：${String(error.stdout ?? error.stderr ?? error.message).split('\n')[0].slice(0, 160)}`,
    '修好组合再启动；若确认是闸门自身的问题，可临时用  set DSH_SKIP_GATE=1  跳过')
}

const rows = dump === '' ? [] : parseRows(dump)

// ── 2. every mounted LOCAL bundle: does the installed module accept its config? ──
const profilePkg = JSON.parse(readFileSync(`${PROFILE}\\package.json`, 'utf8'))
const deps = profilePkg.dependencies ?? {}
const mounted = profilePkg.dsh?.profile?.bundles ?? []
const localDeps = Object.entries(deps).filter(([, spec]) => spec.startsWith('file:') || spec.startsWith('link:'))
let validated = 0
/** Package names whose installed module ACCEPTED its composed config (authoritative). */
const validatedNames = new Set()
for (const [depName, spec] of localDeps) {
  const sourceDir = spec.replace(/^(file:|link:)/u, '')
  const installedDir = `${PROFILE}\\node_modules\\${depName}`
  const isMounted = mounted.includes(depName)
  if (!existsSync(installedDir)) {
    if (isMounted) fail(`本地包 ${depName} 已挂载但 node_modules 里不存在`, `在 ${PROFILE} 里跑：pnpm install`)
    continue
  }
  // 2a. byte drift between source and installed copy
  const pkgJson = existsSync(`${installedDir}\\package.json`) ? JSON.parse(readFileSync(`${installedDir}\\package.json`, 'utf8')) : {}
  const entryRel = (pkgJson.main ?? 'index.js').replace(/\\/gu, '\\')
  const filesToCompare = ['package.json', entryRel, 'cordis.patch.yml']
  for (const rel of filesToCompare) {
    const a = `${sourceDir}\\${rel}`
    const b = `${installedDir}\\${rel}`
    if (!existsSync(a) || !existsSync(b)) continue
    const same = readFileSync(a).equals(readFileSync(b))
    if (!same) {
      fail(`安装副本与源码不一致：${depName}\\${rel}（源码 ${statSync(a).size} 字节 / 安装 ${statSync(b).size} 字节）`,
        `在 ${PROFILE} 里跑：pnpm install   然后重跑本闸门`)
    }
  }
  // 2b. does the installed module accept the composed config for its row?
  const row = rows.filter((r) => r.name === depName && !r.disabled).pop()
  if (row === undefined) continue
  try {
    const mod = await import(pathToFileURL(`${installedDir}\\${entryRel}`).href)
    if (typeof mod.resolvePolicy !== 'function') continue
    validated += 1
    const config = {}
    for (const [k, v] of Object.entries(row.config)) {
      config[k] = v === 'true' ? true : v === 'false' ? false : (/^\d+$/u.test(v) ? Number(v) : v)
    }
    try {
      mod.resolvePolicy(config)
      validatedNames.add(depName)
      pass(`行 ${row.id}（${depName}）的配置被安装副本接受：${JSON.stringify(config)}`)
    } catch (error) {
      fail(`行 ${row.id}（${depName}）配置被安装副本拒绝：${error instanceof Error ? error.message : String(error)}`,
        `改回该行的 config，或在 ${HOME_PATCH} / 该包自带补丁里把它禁用；改完重跑本闸门`)
    }
  } catch (error) {
    warn(`无法导入 ${depName} 的安装副本做配置校验：${String(error.message).slice(0, 120)}`)
  }
}
if (validated === 0 && localDeps.length > 0) warn('没有任何本地包导出 resolvePolicy —— 本次只做了字节一致性检查（覆盖面有限，如实记录）')

// ── 3. last crash's signature (advisory fallback only) ─────────────────────
// FIRST VERSION REFUSED HERE AND WAS WRONG: it treated a historical crash message
// as proof of a current inconsistency, so a healthy (already fixed) composition was
// blocked — a gate that blocks a working boot is worse than no gate. The
// authoritative test is check 2 (the installed module accepts the composed config).
// This check therefore only WARNS, only for packages that could not be validated
// programmatically, and only once per (key, row).
try {
  const tail = readFileSync(LOG, 'utf8').split('\n').slice(-400).join('\n')
  const seen = new Set()
  for (const m of tail.matchAll(/unknown config key "([^"]+)"/gu)) {
    const key = m[1]
    const hit = rows.find((r) => Object.hasOwn(r.config, key))
    if (hit === undefined) continue
    if (validatedNames.has(hit.name)) continue
    const dedupe = `${key}|${hit.id}`
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    warn(`日志里上一次启动曾因未知配置键 "${key}" 失败，而它仍在行 ${hit.id} 的 config 里；该包没有导出 resolvePolicy，无法程序化确认`,
      `确认该模块是否接受这个键；若不确定，先在 ${PROFILE} 里跑 pnpm install 让副本与源码一致`)
  }
} catch (error) {
  warn(`读不到 ${LOG} 的尾部：${String(error.message).slice(0, 80)}`)
}

// ── 4. port already served (advisory only) ────────────────────────────────
try {
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`],
  { encoding: 'utf8' }).trim()
  if (out !== '') {
    const proc = execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${out.split('\n')[0].trim()}").CommandLine`], { encoding: 'utf8' }).trim()
    const isHost = proc.includes('dsh\\lib\\bin.js')
    warn(`端口 ${PORT} 已被 PID ${out.split('\n')[0].trim()} 占用${isHost ? '（是另一个 dsh 宿主）' : ''}`,
      isHost ? '先结束那个宿主（关掉它的启动窗口）再启动，否则新实例抢不到端口会静默退出' : '确认该端口占用是否影响启动')
  } else {
    pass(`端口 ${PORT} 空闲`)
  }
} catch (error) {
  warn(`端口检查失败：${String(error.message).slice(0, 80)}`)
}

// ── report ────────────────────────────────────────────────────────────────
const failed = findings.filter((f) => f.level === 'FAIL')
if (!quiet) {
  console.log('=== DSH 启动前闸门（config\\start-gate.mjs）===')
  for (const f of findings) {
    console.log(`  [${f.level}] ${f.msg}`)
    if (f.fix !== undefined) console.log(`         → ${f.fix}`)
  }
}
const verdict = failed.length === 0 ? 'PASS' : 'REFUSED'
// The verdict always lands in a file the gate owns. Appending to the launcher's console
// log is BEST-EFFORT: while the host runs, the launcher holds that file open and
// appendFileSync fails (EBUSY/EPERM). The first version swallowed that in an empty catch,
// so the gate ran for a whole session without leaving a single line — a silent
// diagnostic failure, which is worse than a missing convenience.
const verdictLine = `[gate] ${verdict} ${new Date().toISOString()} failures=${failed.length} warnings=${findings.filter((f) => f.level === 'WARN').length}`
try {
  mkdirSync(STATE, { recursive: true })
  appendFileSync(`${STATE}\\gate.log`, `${verdictLine}\n`, 'utf8')
} catch (error) {
  console.error(`[gate] 无法写入 ${STATE}\\gate.log：${String(error.message).slice(0, 120)}`)
}
try {
  appendFileSync(LOG, `${verdictLine}\n`, 'utf8')
} catch (error) {
  if (!quiet) console.log(`  [note] 判定未能写入 dsh-console.log（${String(error.code ?? error.message).slice(0, 40)}）—— 已记入 ${STATE}\\gate.log`)
}

if (failed.length > 0) {
  console.log(`\n[dsh] 闸门拦停：${failed.length} 项确证不一致。修好上面的项，或临时用  set DSH_SKIP_GATE=1  跳过闸门。`)
  process.exit(1)
}
if (!quiet) console.log('  [PASS] 未发现确证不一致 —— 允许启动')
process.exit(0)
