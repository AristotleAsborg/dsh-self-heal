/**
 * write-host-down-readme.mjs — the FIXED script that puts the general guide at a
 * fixed location when every automatic rung has failed.
 *
 * Fixed location (stable, right next to the launcher so a human staring at the
 * launcher window finds it):  <harness>\HOST-DOWN-README.md
 * History copy (never overwritten):  <incident>\HOST-DOWN-README.md
 *
 * The guide text itself lives in one versioned source file; this script only copies
 * it and appends the incident facts (classification, ladder outcomes, error lines),
 * so the two never drift apart.
 *
 * It also SUBSTITUTES the guide's {{PLACEHOLDER}} tokens with paths resolved from the kit
 * config. WHY: this document is read by a human at the worst possible moment, so a wrong
 * path costs the most here. The source used to hardcode one machine's D:\dsh\... layout, and
 * after the state root moved to $DSH_HOME\state the guide still told the reader to look in
 * <harness>\state\incidents\ — an empty directory. Placeholders make the copied guide correct
 * for whatever layout is actually installed.
 *
 * Usage: node write-host-down-readme.mjs [--incident <dir>] [--print]
 * Exit:  0 = written, 2 = the guide source is missing (nothing else can be done here).
 */
import * as CFG from './self-heal.config.mjs'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'

const GUIDE = CFG.GUIDE
const FIXED = CFG.FIXED
const INCIDENTS = CFG.INCIDENTS

/**
 * Every placeholder the guide may use, resolved from the same config the scripts use.
 * Add a key here when the guide needs one — do not reintroduce a literal path.
 * @returns map of token (without braces) to value.
 */
export function guideTokens() {
  // Derive the harness root and its config dir from CONFIG_PATH, which self-heal.config.mjs
  // already resolved. Earlier this guessed by stripping a trailing `\home` from HOME — wrong as
  // soon as `--home` points somewhere that is not <harness>\home, and silently wrong at that.
  const configDir = CFG.CONFIG_PATH.replace(/[\\/][^\\/]+$/u, '')
  const harness = configDir.replace(/[\\/]config$/iu, '')
  return {
    HARNESS: harness,
    HOME: CFG.HOME,
    CONFIG_DIR: configDir,
    INCIDENTS: CFG.INCIDENTS,
    LOG: CFG.LOG,
    LAUNCHER: CFG.LAUNCHER,
    CLI: CFG.BIN,
    PROFILE: CFG.PROFILE,
    PROFILE_DIR: `${CFG.HOME}\\profiles\\${CFG.PROFILE}`,
    HOME_PATCH: CFG.HOME_PATCH,
  }
}

/**
 * Replace {{TOKEN}} occurrences. An unknown token is left visible on purpose and reported,
 * because silently emitting an empty string would turn a broken path into a plausible-looking
 * one — the exact failure this substitution exists to prevent.
 * @param text - the guide source.
 * @param tokens - the resolved token map.
 * @returns the rendered text and the list of unknown tokens found.
 */
export function renderGuide(text, tokens) {
  const unknown = new Set()
  const out = text.replace(/\{\{([A-Z_]+)\}\}/gu, (match, key) => {
    if (Object.hasOwn(tokens, key)) return tokens[key]
    unknown.add(key)
    return match
  })
  return { text: out, unknown: [...unknown] }
}

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}
const newest = () => {
  // Guarded for the same reason as incident-repair.mjs: without this, running the fallback
  // guide writer before any incident exists throws ENOENT instead of writing the guide — i.e.
  // the last-resort path fails exactly when someone reaches for it.
  if (!existsSync(INCIDENTS)) return undefined
  const dirs = readdirSync(INCIDENTS, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, at: statSync(`${INCIDENTS}\\${e.name}`).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  return dirs.length === 0 ? undefined : `${INCIDENTS}\\${dirs[0].name}`
}
const incident = opt('--incident', newest())

if (!existsSync(GUIDE)) {
  console.error(`write-host-down-readme: 缺少通用说明源文件：${GUIDE}`)
  process.exit(2)
}

const readMaybe = (path, maxLines = 80) => {
  if (path === undefined || !existsSync(path)) return '(无)'
  const lines = readFileSync(path, 'utf8').split('\n')
  return lines.slice(0, maxLines).join('\n') + (lines.length > maxLines ? `\n…（共 ${lines.length} 行，已截断）` : '')
}

const incidentBlock = [
  '',
  '---',
  '',
  `## 本次事故（自动追加 ${new Date().toISOString()}）`,
  '',
  `- 事故目录：${incident ?? '(无)'}`,
  `- 已自动尝试：启动前闸门 → 看护脚本（允许清单内修复）→ L1 修复会话（headless）→ L1.5 出厂 profile（rescue）`,
  '- **上面四级都没能救回来**，所以留下了这份文档。',
  '',
  '### 分级结果（ladder.md）',
  '',
  '```',
  readMaybe(incident === undefined ? undefined : `${incident}\\ladder.md`, 40),
  '```',
  '',
  '### 事故摘要（summary.md）',
  '',
  '```',
  readMaybe(incident === undefined ? undefined : `${incident}\\summary.md`, 50),
  '```',
  '',
  '### 报错原文尾部（console-tail.txt 的最后 25 行）',
  '',
  '```',
  (() => {
    if (incident === undefined || !existsSync(`${incident}\\console-tail.txt`)) return '(无)'
    return readFileSync(`${incident}\\console-tail.txt`, 'utf8').split('\n').slice(-25).join('\n')
  })(),
  '```',
  ''
].join('\n')

const guideSource = readFileSync(GUIDE, 'utf8')
const rendered = renderGuide(guideSource, guideTokens())
if (rendered.unknown.length > 0) {
  console.error(`write-host-down-readme: 通用说明里有未知占位符，已原样保留：${rendered.unknown.map((k) => `{{${k}}}`).join(', ')}`)
}
writeFileSync(FIXED, `${rendered.text.replace(/\s+$/u, '')}\n${incidentBlock}`, 'utf8')
if (incident !== undefined) {
  mkdirSync(incident, { recursive: true })
  copyFileSync(FIXED, `${incident}\\HOST-DOWN-README.md`)
}

console.log(`[host-down] 通用说明已写到固定位置：${FIXED}`)
if (incident !== undefined) console.log(`[host-down] 历史副本：${incident}\\HOST-DOWN-README.md`)
if (argv.includes('--print')) console.log(`[host-down] 字数：${readFileSync(FIXED, 'utf8').length}`)
process.exit(0)
