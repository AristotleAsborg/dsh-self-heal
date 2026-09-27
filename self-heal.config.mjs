/**
 * self-heal.config.mjs — every path the kit uses, resolved in ONE place.
 *
 * Resolution order (first hit wins, per key):
 *   1. environment      DSH_SELFHEAL_<KEY>      e.g. DSH_SELFHEAL_HOME
 *   2. config file      <harness>\config\self-heal.config.json   (written by the installer)
 *   3. environment      DSH_HOME                for HOME only
 *   4. defaults derived from the harness root
 *
 * The runtime scripts import from here instead of hardcoding D:\dsh\..., so one installation
 * can serve any layout. Non-path constants (timeouts, ports, budgets) live here too, because
 * the installer records them alongside the paths.
 */
import { existsSync, readFileSync } from 'node:fs'

const env = process.env
const pick = (...values) => values.find((v) => v !== undefined && v !== null && v !== '')

// The harness root has to be resolved before the config file path is known: env or default.
const HARNESS = pick(env.DSH_SELFHEAL_HARNESS, 'D:\\dsh')

let file = {}
const configPath = `${HARNESS}\\config\\self-heal.config.json`
if (existsSync(configPath)) {
  try { file = JSON.parse(readFileSync(configPath, 'utf8')) } catch { file = {} }
}
const get = (key, fallback) => pick(env[`DSH_SELFHEAL_${key.toUpperCase()}`], file[key], fallback)

export const CONFIG_PATH = configPath
export const NODE = get('node', pick(env.DSH_SELFHEAL_NODE, 'D:\\dsh\\runtime\\node\\node.exe'))
export const BIN = get('bin', `${HARNESS}\\runtime\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`)
export const HOME = get('home', pick(env.DSH_HOME, `${HARNESS}\\home`))
export const PROFILE = get('profile', 'web')
export const PORT = Number(get('port', 3080))
export const PROBE_PORT = Number(get('probePort', PORT + 1))
export const LOG = get('log', `${HARNESS}\\dsh-console.log`)
export const STATE = get('state', `${HOME}\\state`)
export const INCIDENTS = get('incidents', `${STATE}\\incidents`)
export const SESSIONS = get('sessions', `${HOME}\\sessions`)
export const ATTEMPTS = get('attempts', `${STATE}\\repairs\\attempts.json`)
export const HOME_PATCH = get('homePatch', `${HOME}\\cordis.patch.yml`)
export const PROFILE_PATCH = get('profilePatch', `${HOME}\\profiles\\${PROFILE}\\cordis.patch.yml`)
export const GATE = get('gate', `${HARNESS}\\config\\start-gate.mjs`)
export const SUPERVISOR = get('supervisor', `${HARNESS}\\config\\host-supervisor.mjs`)
export const LADDER = get('ladder', `${HARNESS}\\config\\incident-repair.mjs`)
export const OVERLAY = get('overlay', `${HARNESS}\\config\\repair\\repair-overlay.yml`)
export const PROMPT_FILE = get('promptFile', `${HARNESS}\\config\\repair\\repair-prompt.md`)
export const GUIDE_WRITER = get('guideWriter', `${HARNESS}\\config\\write-host-down-readme.mjs`)
export const GUIDE = get('guide', `${HARNESS}\\config\\repair\\HOST-DOWN-README.md`)
export const FIXED = get('fixed', `${HARNESS}\\HOST-DOWN-README.md`)
export const LAUNCHER = get('launcher', `${HARNESS}\\start-dsh.cmd`)
export const PROBE_BUDGET_MS = Number(get('probeBudgetMs', 30000))
export const TAIL_LINES = Number(get('tailLines', 200))
export const COOLDOWN_MS = Number(get('cooldownMs', 600000))
export const MAX_ATTEMPTS = Number(get('maxAttempts', 1))

export default {
  CONFIG_PATH, NODE, BIN, HOME, PROFILE, PORT, PROBE_PORT, LOG, STATE, INCIDENTS, SESSIONS,
  ATTEMPTS, HOME_PATCH, PROFILE_PATCH, GATE, SUPERVISOR, LADDER, OVERLAY, PROMPT_FILE,
  GUIDE_WRITER, GUIDE, FIXED, LAUNCHER, PROBE_BUDGET_MS, TAIL_LINES, COOLDOWN_MS, MAX_ATTEMPTS,
}
