# dsh-self-heal

**v0.1.3** · [![CI](https://github.com/AristotleAsborg/dsh-self-heal/actions/workflows/ci.yml/badge.svg)](https://github.com/AristotleAsborg/dsh-self-heal/actions/workflows/ci.yml)

English | [中文](README.zh-CN.md)

Startup gate, crash supervisor and a bounded repair ladder for a DeepSeek Harness installation. Windows, Node 20+.

The version lives in [`VERSION`](VERSION) and is the only place it is written down; a release is that
file plus a matching `git tag v<version>`. There is no build step and no package manifest, so nothing
else has to stay in step with it.

**It starts on its own — you do not invoke anything.** Once installed, the whole chain is wired into your
existing launcher, and it runs whether or not anyone is watching:

- **Before every launch**, the gate checks the composition and refuses to start on a *confirmed*
  inconsistency.
- **When the host exits non-zero, the supervisor starts by itself.** Every failure path routes through the
  launcher's exit code, so a crash — a window that closes instantly, a bad upgrade, a plugin that will not
  load — is enough to trigger it. No second launcher, no manual step, no console left open.
- **The repair ladder then starts by itself** too (`DSH_SUPERVISOR_REPAIR_AGENT=1` is the installer's
  default), hands the evidence to a bounded headless session, and does not touch the user's own launcher
  while doing it.

Everything below describes what those automatic steps do and how to read their output. The one deliberate
exception is documented under "Safety properties": recovery is bounded, and it stops rather than looping.

## What it is compatible with

**It wraps the `dsh` command line, so it works with any DSH version whose CLI keeps the interfaces it
uses.** That is a small, stable surface, and which parts of it were checked is stated below rather than
assumed.

| Against | Status |
| --- | --- |
| `dsh` CLI `0.1.6-alpha.2` | The version this kit was developed and measured on. |
| `dsh` CLI `0.1.7-rc.2` | **Compatible** — checked by comparing the two releases, see below. |
| **The official desktop (Electron) app** | **Not supported.** It has its own launcher and lifecycle, and the CLI explicitly refuses its profile. Details below. |

What the kit uses, and why version changes rarely reach it:

- **Six CLI affordances only**: `--profile`, `--patch`, `--dump-config`, `--from-default-profile`,
  `--help`, `--version`. The kit never imports a DSH internal module, so the internals are free to move.
- **The `--dump-config` YAML**, which the gate parses by hand. This is the one real coupling, so it was
  compared directly: `renderConfigDump`, `groupedDump` and the `!!js` schema type in
  `@deepseek-ai/dsh-app-boot` are **byte-identical** between those two versions. The dump format did not
  change.
- **Your profile layout**: `package.json` with `dsh.profile.bundles`, plus `cordis.patch.yml` layers, in
  that order. Unchanged between the two versions.
- **Your local plugins**, which declare **no DSH peer ranges** — so the plugin/runtime compatibility gate
  introduced in 0.1.7 does not apply to them. That gate only evaluates a manifest that actually declares
  `peerDependencies`.

### The desktop app is a different entry point, not a version

The official desktop client is Electron and reuses the Web UI and the same agent/session/plugin logic, but
it is launched by its own application rather than by `dsh`, and the CLI **reserves the `desktop` profile
for it**:

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

That is the shipping CLI's own guard, not an inference. The official desktop documentation in the
`deepseek-ai/deepseek-harness` repository describes the rest of the picture, and it is a deliberate
separation rather than an oversight:

- The desktop app is `apps/desktop`, published as `@deepseek-ai/dsh-desktop` with **`"private": true`** —
  which is why there is no such npm package. It ships as an installer from `download.deepseek.com`.
- Electron starts a RunAsNode child that runs **the shared profile runner**, and the signed app serves the
  bundled `dsh` and its production dependencies from `resources/app.asar/dsh`. The profile therefore only
  installs *external* plugins.
- Electron takes a single-instance lock and **owns `$DSH_HOME/profiles/desktop` exclusively**, along with
  its package-manager state. In the project's own words, the CLI and the desktop app "share the supported
  product data under `$DSH_HOME`, but never the executable packages, plugin activation, lockfiles or
  `node_modules`" — and **"the CLI cannot boot or modify this profile."**
- The desktop app listens on port **19387** by default, separate from Web's `3080`.

It matters here for two structural reasons:

1. The gate runs *before* the CLI boots and the supervisor runs *on the launcher's exit code*. An Electron
   app owns both moments — and already ships its own recovery dialog for a fatal startup failure (restart,
   disable third-party plugins, back up the profile patch). There is no point at which this kit could insert
   itself, and the kit does not try to wrap or modify a GUI application's startup.
2. Pointing this kit at the desktop profile cannot work: every command it calls would be rejected by that
   guard. The installer and the gate do not need you to discover this by experiment — do not set
   `profile: "desktop"` (the installer refuses it outright).

**Both do share one thing, so mind it.** The desktop app and the CLI share `$DSH_HOME`, and the home-level
patch `$DSH_HOME/cordis.patch.yml` is applied when the CLI composes its tree — verified here by removing it
and re-dumping, which changed the composition (656 lines to 636). The desktop's profile keeps the same home
patch. So if you install this kit *and* run the desktop app on the same home, treat that one file as shared:
the repair session is allowed to edit it, and an edit there is not confined to your CLI profile. That is
recorded as a caveat, not as a claim that the kit manages the desktop app — it does not.

If you run the desktop app, run this kit against your CLI installation (`dsh`/`dsh web`) as its own thing.
They can coexist; they are separate lifecycles.

**How far this was checked**: the CLI compatibility above is a comparison of the two published releases
(contracts, emitters and guards read out of the tarballs), **not** an end-to-end run of the kit on 0.1.7.
The desktop facts above come from the official repository's `apps/desktop` documentation and manifest, but
**the kit has never been run against the desktop app at all** — no desktop build was installed on this
machine, so there was nothing to run it against.

## What it does

| Stage | File | Behaviour |
| --- | --- | --- |
| L0-1 gate | `start-gate.mjs` | Composes the profile tree before launch and refuses to start on a **confirmed** inconsistency: a config key the installed module rejects, or an installed copy that has drifted from its source. Fails open — a missing gate file or an internal error only warns. Verdict appended to `$DSH_HOME\state\gate.log`, and to the host log when that file is writable. |
| L0 supervisor | `host-supervisor.mjs` | **Runs automatically on a non-zero host exit.** Writes an incident bundle (log tail, gate verdict, composed tree), classifies the failure against the **last** launch attempt, and performs the one allow-listed repair: re-sync the installed bundles (`pnpm install`), then re-check the gate. Never changes the launcher's exit code. After a **verified** repair it relaunches once (bounded to one per 10 minutes; opt out with `DSH_NO_RELAUNCH=1`). A summary is written before any long-running step, so a killed run still leaves one. |
| L1 / L1.5 repair | `incident-repair.mjs` | **Starts automatically after the supervisor**, and hands the incident to a bounded headless session — first `--profile headless`, then the factory `rescue` profile — under `repair/repair-overlay.yml`. Each rung runs detached with its output in the incident directory, so closing the window neither stops nor erases it; the console tails that file for live progress. |
| Verdict | `incident-repair.mjs` | A rung counts as repaired when a real **boot probe** of the composition survives (scratch port 3081, hard timeout). Exit codes are not evidence, and a missing agent report is a warning rather than a veto. |
| Fallback | `write-host-down-readme.mjs` | When no rung repairs it, copies `repair/HOST-DOWN-README.md` to a fixed path next to the launcher and appends the incident facts. |

## Requirements and expected layout

Paths are **not** hardcoded constants inside the scripts: every script resolves them through
`self-heal.config.mjs`, which reads `environment → <harness>\config\self-heal.config.json → default`.
The installer writes that JSON as the single source of truth, so moving to another machine means
re-running the installer (or editing that one file) rather than editing code.

| Key / value | This checkout |
| --- | --- |
| harness root `harnessRoot` (`--harness`) | `D:\dsh` |
| `$DSH_HOME` (`home`) | `D:\dsh\home` |
| profile `profile` | `web` |
| host log `log` / gate log `state\gate.log` | `D:\dsh\dsh-console.log`, `$DSH_HOME\state\gate.log` |
| incident bundles `incidents` | `$DSH_HOME\state\incidents\<timestamp>-exit<N>\` |
| repair probe port `probePort` | 3081 |

Overridable environment variables: `DSH_SELFHEAL_HARNESS` (harness root) and `DSH_SELFHEAL_NODE`
(the node interpreter). Any other key is overridden as `DSH_SELFHEAL_<KEY>`, e.g.
`DSH_SELFHEAL_STATE`, `DSH_SELFHEAL_INCIDENTS`.

> **Upgrade note**: releases before 2026-09-27 wrote `state` and incident bundles under
> `<harness>\state\`, while the kit config defaults to `$DSH_HOME\state\`. If you have older
> bundles in `<harness>\state\incidents\`, add an explicit `"state"` (or `"incidents"`) key to the
> JSON pointing at them — the installer **preserves** both keys rather than overwriting them.

`DSH_HOME` is passed explicitly to every child process: the launcher's environment does not carry it, and without it the CLI silently composes a different installation's home.

## Install

Option A — the installer (recommended):

```powershell
node self-heal-install.mjs check      # show the resolved paths and what is missing
node self-heal-install.mjs install    # --harness <dir> --home <dir> --launcher <file>
```

`install` writes `<harness>\config\self-heal.config.json` (every path lives there, so no script
carries a hardcoded layout), copies the kit, wires your launcher — CRLF-only, idempotent, with a
`.bak-selfheal-*` copy — so that a plain `start-dsh.cmd` wakes the gate, the supervisor and the
L1 repair ladder (`DSH_SUPERVISOR_REPAIR_AGENT=1`, opt out with `DSH_NO_REPAIR_AGENT=1`), creates
the factory fallback profile, and finally runs the gate to prove the result. If your launcher does
not look like a DSH launcher it is left alone and a `start-dsh-self-heal.cmd` wrapper is written
instead. `uninstall` removes the wiring block.

The installer is **idempotent and self-converging**: re-running it leaves the launcher byte-identical,
and a launcher that a human has mangled (say, with the wiring block duplicated several times) is
collapsed back to exactly one copy before it exits. `install` refreshes only the config keys it owns —
**keys you added to the JSON yourself are preserved and reported**, never silently dropped.

After wiring, prove it in one read-only step (runs the gate, does not start the host):

```powershell
$env:DSH_NO_PAUSE=1; cmd /c "D:\dsh\start-dsh.cmd -GateOnly"
```

Two bugs fixed here, both of which made the installer lie about success: it derived its own
directory from `import.meta.url`'s `.pathname`, which is percent-encoded, so any path containing a
space became `%20` and the kit copy died with `ENOENT` — **half-installed: config written, scripts
not copied**. And the launcher lookup for `start-dsh.ps1` also matched a *comment* line, so each run
inserted one more wiring block.

Option B — by hand:

1. Copy the `*.mjs` files to `<harness>\config\` and `repair/` to `<harness>\config\repair\`.
2. Wire the launcher, see `launcher-integration.md`. In this checkout the gate runs before launch, the supervisor runs on a non-zero exit, and `DSH_SUPERVISOR_REPAIR_AGENT=1` is set by default so a crash reaches the repair ladder without a second launcher.
3. Create the factory fallback profile once: `node <dsh bin.js> rescue --from-default-profile headless --dump-config`.

## Use

```powershell
# check consistency only, do not boot the host
<harness>\start-dsh.cmd -GateOnly

# hand the newest incident to the repair ladder by hand
node <harness>\config\incident-repair.mjs --ladder

# see what the ladder WOULD do, without launching anything (costs nothing)
node <harness>\config\incident-repair.mjs --dry-run

# collect the evidence and stop, without attempting a repair
node <harness>\config\incident-repair.mjs --no-ladder
```

| Switch | Meaning |
| --- | --- |
| `DSH_SKIP_GATE=1` | Skip the gate once |
| `DSH_NO_PAUSE=1` | Let the launcher window close by itself after a crash |
| `DSH_NO_REPAIR_AGENT=1` | Do not start the repair ladder automatically |
| `DSH_SELFHEAL_TRUST_L0=1` | After L0 resyncs cleanly and the gate passes, skip the ladder (saves one call) |
| `DSH_NO_RELAUNCH=1` | Do not relaunch automatically after a verified repair |
| `-GateOnly` | Run the gate and exit with its verdict |
| `--dry-run` (ladder) | Plan only. Launches **no** session and no probe, so it costs nothing |
| `--no-ladder` (ladder) | Collect evidence and stop. Starts no rung at all |

### L0 and L1 cascade, and why the gate is not the signal

L0 (the one allow-listed `pnpm install` resync) and L1 (the bounded repair ladder) used to be mutually
exclusive: drift meant L0 and nothing else. That made the ladder unreachable in the case that needs it
most — **drift present and the resync unable to clear it**. They now cascade.

The ladder runs whenever the host exited non-zero and L0 did not demonstrably fix it. Note what is
*not* the signal: **a passing gate does not mean the host can start.** The gate is deliberately
fail-open, so it stays silent about anything it cannot verify — measured on 2026-09-27, a plugin whose
entry module had a syntax error (source and installed copy byte-identical, so no drift to report)
produced `闸门：PASS` while the host could not boot at all. Gating the ladder on the gate verdict
therefore withheld it exactly when the gate was blind.

The one reliable fact is that **the host already exited non-zero** — that is why the supervisor is
running. So the ladder is the default, and skipping it is an explicit opt-in: set
`DSH_SELFHEAL_TRUST_L0=1` if you would rather not spend a call after a clean resync. A ladder that runs
when it was not needed costs one call; one that does not run when it *was* needed leaves you with a
host that cannot start.

### It brings the host back up

L1 and L0 both end the same way: **when the repair is verified, the host is relaunched.** A verified
repair means the ladder's boot probe came back ALIVE, or L0's resync was followed by a passing gate. If
the repair is not verified, the gate currently refuses, or `DSH_NO_RELAUNCH=1` is set, the supervisor
records why and leaves the host down for a human.

This is on by default because the alternative was measured and it was bad: the kit repaired the host,
reported success, and then left it down, so the operator had to notice and restart by hand. Relaunching
is bounded to **one per cooldown window** (recorded in `attempts.json`), so it cannot become a crash
loop — a second launch that fails lands in the same bounded path as the first.


## Safety properties

- The gate fails open; a missing or broken gate never blocks a launch.
- The supervisor never changes the launcher exit code, and relaunches **only** after a verified repair, at most once per cooldown window.
- The only automatic repair is a reversible `pnpm install` re-sync, and it re-checks the gate afterwards.
- The repair session runs with `workspace-write` rooted at `$DSH_HOME`, `approval: never`, telemetry and the session-log request field off; a write outside `$DSH_HOME` is denied by the sandbox, and the session contract tells it to stop and report instead of escalating.
- Evidence is independent of the console window: rungs run detached, their logs land in the incident directory, and the verdict file is rewritten after every step.
- Loop guards: at most one repair per 10 minutes; every ladder rung runs at most once per incident.
- Inside the repair session child processes cannot be spawned (the sandbox refuses), so the contract's checks are text-level comparisons rather than tool invocations.

## Files

```
start-gate.mjs                  L0-1 startup gate
host-supervisor.mjs             L0 incident capture + allow-listed repair
incident-repair.mjs             L1 / L1.5 repair ladder, boot probe and verdict
write-host-down-readme.mjs      fixed-location operator guide writer
repair/repair-overlay.yml       policy for the repair session
repair/repair-prompt.md         repair contract: allow-list, report path, stop conditions
repair/HOST-DOWN-README.md      operator guide
repair/plumbing-test-prompt.md  harmless prompt for testing the plumbing
self-heal.config.mjs            one place where every path is resolved
self-heal-install.mjs           option-A installer: config, copy (incl. repair\), wire, fallback profile, verify
launcher-integration.md         the launcher lines to add
```

`repair\HOST-DOWN-README.md` uses `{{HARNESS}}`, `{{HOME}}`, `{{INCIDENTS}}`, `{{CLI}}` and friends instead of
literal paths; `write-host-down-readme.mjs` substitutes them from the live config when it writes the guide
(an unknown placeholder is left visible and reported). One source file therefore yields **correct** paths on
any layout — the previously hardcoded version pointed at the wrong directory once the state root moved.

An incident directory holds `summary.md`, `console-tail.txt`, `gate.txt`, `dump-config.txt` and, when they were
produced, `ladder.md`, `boot-probe.log`, `repair-live-<n>.log`, `repair-report.md`. **They are not uniformly
present**: the first three are essentially always there, while `ladder.md` only exists if the ladder ran and
`repair-report.md` is frequently absent (the repair session's workspace is `$DSH_HOME`, so its report normally
lands in `$DSH_HOME\repair-<incident>\` and the supervisor copies it back on a best-effort basis). Do not use
"all files present" as a health criterion.

## Tests and CI

`.github/workflows/ci.yml` runs on Windows (every script here depends on cmd.exe batch semantics,
CRLF-only launcher files and a native pnpm.exe — a Linux runner would exercise a different program) and
checks four things: that every shipped script parses, that the kit directory matches the installer's
copy list, that the installer works end to end, and that no script carries a machine-specific path.

Run the end-to-end suite locally — it needs no dsh CLI:

```powershell
node ci-test.mjs        # drives the real installer against a scratch harness
node diff-parse.mjs --self-test   # the dump reader vs the real yaml package
```

Both are developed against a scratch harness whose path **contains a space**, and the installer checks
are run **twice** (a repeat run must be a no-op). That is not decoration: the failure modes that mattered
most were invisible in a single run on an ordinary path. Neither suite is a substitute for starting the
host once — see "What normal looks like" below.

Why the kit is tested this way, and what each check has caught, is recorded in the handover document
rather than here.

## What normal looks like

Everything below is an observed example, not an illustration. Use it as the reference for "is this
installation healthy?" before reaching for the troubleshooting table.

**The gate appends exactly one line per run** to `$DSH_HOME\state\gate.log`:

```
[gate] PASS 2026-09-27T12:31:52.356Z failures=0 warnings=1
```

`failures=0` is the part that matters. `warnings=1` is routinely the "port 3080 is already held by
PID …" advisory — normal whenever a host is already running. A `failures=<n>` line means the gate
**refused**; the same run's stdout names each failing item and prints the fix under it.

**A healthy boot announces its URL and stays up.** In practice about one second in:

```
dsh web: http://127.0.0.1:3080/?token=…
```

That single line is the only reliable "it booted" signal. An exit code cannot tell you this, which is
why the kit's verdicts are boot probes rather than return values.

**Being told a row is fine is normal output you should read**, not noise:

```
[PASS] 组合树可解析（dump-config 成功）
[PASS] 行 selfheal（dsh-plugin-selfheal）的配置被安装副本接受：{"enabled":true,"allowRepair":false}
[PASS] 未发现确证不一致 —— 允许启动
```

Note the second shape: the gate **imports each installed local package and calls its `resolvePolicy`**
with the composed config. A package that exports no `resolvePolicy` gets this instead, and the gate
says so rather than implying coverage it does not have:

```
[WARN] 没有任何本地包导出 resolvePolicy —— 本次只做了字节一致性检查（覆盖面有限，如实记录）
```

**The supervisor records one line per incident** in `$DSH_HOME\state\supervisor.log`:

```
[supervisor] incident=…\20260927110428-exit4 classes=entry-failure actions=3 2026-09-27T11:07:15.486Z
```

**An incident package is not uniformly populated** — do not use "all files present" as a criterion.
A real, successful one:

```
boot-probe.log  console-tail.txt  dump-config.txt  gate.txt
ladder.md  ladder-live.log  repair-live-1.log  repair-task.txt  summary.md
```

`gate.txt`, `console-tail.txt` and `dump-config.txt` are essentially always there; `ladder.md` only
if the ladder ran (a package from an L0-only repair has neither). The repair session writes its report
to `$DSH_HOME`, because the incident directory is outside its workspace, so the supervisor searches
both `$DSH_HOME\repair-<incident>.md` and `$DSH_HOME\repair-report.md` and copies what it finds into
the package. A missing report is a warning and not a failure: the verdict is the boot probe.

**The ladder's verdict is a small table**, and `REPAIRED` is decided by the probe column, not the
report column — the two legitimately disagree:

```
| 级                        | 进程 | 报告                     | 启动探针                 | 判定     |
| L1 headless + 修复 overlay | ok   | D:\dsh\home\repair-….md | ALIVE（已 announce URL） | REPAIRED |
```

## Troubleshooting

| Symptom | What it means, and what to do |
| --- | --- |
| `[dsh] startup gate REFUSED to launch` | The most common and most fixable. Every `[FAIL]` line is followed by `→ <fix command>`; run it and re-run `-GateOnly`. For a one-shot bypass: `set DSH_SKIP_GATE=1`. |
| `行 X（包名）配置被安装副本拒绝：unknown config key "K"` | The composed config carries a key the installed module rejects. The loader treats that as fatal, so the host would exit within a second of launch. Remove the key from that row's `config`, or disable the row; re-check with `-GateOnly`. |
| `安装副本与源码不一致：包\文件` | The installed copy drifted from its source. Run `pnpm install` in `<home>\profiles\<profile>` (or let the supervisor's `pnpm install` do it) and re-check. |
| `组合失败：…` | Composing the tree itself failed — the next boot would hit the same thing. The gate refuses and prints the bypass. Read the full error; do not assume it is the gate's fault. |
| Host exits within a second of launch | Read `console-tail.txt` in the newest incident package and **quote the error verbatim before concluding anything**. A failing loader entry is fatal, so the real cause is usually the last entry named. |
| `incident-repair: 没有事故目录（…）` | No incident exists to repair. Exit code 2, nothing was attempted. Not an error. |
| Ladder ran but `repair-report.md` is missing | Only a warning; the verdict is the boot probe in `boot-probe.log`. The session writes to `$DSH_HOME`, so look for `repair-<incident>.md` there too — the supervisor copies it into the package when it finds it. |
| Launcher window closes instantly after a crash | By design once `DSH_NO_PAUSE=1` is set. Unset it to keep the window and read the gate's output in place. |
| `chcp`/mojibake: Chinese text looks doubled in the console | A console code-page artifact (CP936), not file corruption. The launcher already runs `chcp 65001`; if you invoke a script yourself, do the same. The files on disk are UTF-8. |
| Incident packages are in `<harness>\state\incidents` but the config says `<home>\state\incidents` | Two state roots. The config's `state` and `incidents` keys decide where packages go; point them at where your packages really are. The installer now keeps any configured value (and `incidents` follows `state` by default) instead of re-deriving either from `<home>`. |

Start from the two read-only commands in `repair/HOST-DOWN-README.md`; it is the same guidance a human
gets when every automatic rung has failed, and it never deletes anything.

## License

MIT
