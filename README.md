# dsh-self-heal

[![CI](https://github.com/AristotleAsborg/dsh-self-heal/actions/workflows/ci.yml/badge.svg)](https://github.com/AristotleAsborg/dsh-self-heal/actions/workflows/ci.yml)

English | [中文](README.zh-CN.md)

Startup gate, crash supervisor and a bounded repair ladder for a DeepSeek Harness installation. Windows, Node 20+.

## What it does

| Stage | File | Behaviour |
| --- | --- | --- |
| L0-1 gate | `start-gate.mjs` | Composes the profile tree before launch and refuses to start on a **confirmed** inconsistency: a config key the installed module rejects, or an installed copy that has drifted from its source. Fails open — a missing gate file or an internal error only warns. Verdict appended to `$DSH_HOME\state\gate.log`, and to the host log when that file is writable. |
| L0 supervisor | `host-supervisor.mjs` | On a non-zero host exit it writes an incident bundle (log tail, gate verdict, composed tree), classifies the failure against the **last** launch attempt, and performs the one allow-listed repair: re-sync the installed bundles (`pnpm install`), then re-check the gate. Never changes the launcher's exit code, never relaunches by default. A summary is written before any long-running step, so a killed run still leaves one. |
| L1 / L1.5 repair | `incident-repair.mjs` | Hands the incident to a bounded headless session — first `--profile headless`, then the factory `rescue` profile — under `repair/repair-overlay.yml`. Each rung runs detached with its output in the incident directory, so closing the window neither stops nor erases it; the console tails that file for live progress. |
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
| `DSH_SUPERVISOR_RELAUNCH=1` | Allow one relaunch after a successful repair |
| `-GateOnly` | Run the gate and exit with its verdict |
| `--dry-run` (ladder) | Plan only. Launches **no** session and no probe, so it costs nothing |
| `--no-ladder` (ladder) | Collect evidence and stop. Starts no rung at all |

## Safety properties

- The gate fails open; a missing or broken gate never blocks a launch.
- The supervisor never changes the launcher exit code and never relaunches by default.
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
CRLF-only launcher files and a native pnpm.exe — a Linux runner would exercise a different program)
and does four things:

1. **Parse every shipped script** — there is no build step, so nothing else would notice a syntax error.
2. **Check the kit directory against the installer's copy list**, in both directions. The installer
   ships an explicit list, so adding a file does not ship it; `repair\` was silently never copied
   while the config pointed straight at files inside it.
3. **Run `ci-test.mjs`** — 55 checks that drive the real installer end to end.
4. **Reject a machine-specific path in code** (comments excluded; the documented, overridable
   defaults are allow-listed by exact text).

`ci-test.mjs` is deliberately not a unit test. Run against a scratch harness whose path **contains a
space**, it installs, asserts every declared file landed byte-identical, wires a launcher, then runs
the whole thing **again** to prove the second run is a no-op — and mangles the launcher on purpose to
prove a repeat run collapses it back to one copy instead of growing it. The two failure modes that
mattered most (a percent-encoded `%20` path killing the copy, and wiring that grew the launcher on
every run) are both invisible in a single run on an ordinary checkout, which is why they survived
until someone ran the installer somewhere else.

Run it locally with no dsh CLI required:

```powershell
node ci-test.mjs
```

Deliberately not covered by CI, because reaching it needs a real dsh installation: the gate's refusal
of a composed row whose config the installed module rejects. That path is exercised on a real box —
see the incident this kit exists for.

### The dump reader, and why it is compared rather than sampled

`gate-parse.mjs` reads the composed `--dump-config` output so the gate can hand each module the same
config object the host would. It is hand-written (the gate must run with nothing but the CLI's own
`node_modules` present), which makes it exactly the kind of code that looks right and is not.

It was originally checked against a fixture of our own — and that fixture passed while the reader was
wrong in four separate ways. Comparing it against the real `yaml` package over a real 657-line dump
found all four within minutes:

| Defect | What it did |
| --- | --- |
| `name:` kept its quotes | `row.name === depName` never matched, so the gate's per-row config validation was **silently skipped** — the very check that exists to catch config/code drift |
| `!!js` tags kept as text | a JS-valued config compared unequal to itself |
| block scalars (`>-`, `|`) unhandled | the value became the literal marker `">-"`, **silently replacing a long prompt with two characters** |
| sequences of maps lost their keys | `models: [- id: x]` became the strings `"id: x"`; and a row-boundary detector that matched `- id:` inside a row's own nested list made one row swallow every row after it (83 of 172 rows vanished) |

The middle two are why this is worth reading about: both produced a **quietly wrong string**, and a
quietly wrong string is the worst possible outcome for a check whose whole job is to decide whether a
config is acceptable. A loud crash would have been found immediately.

```powershell
# frozen fixtures, needs no dsh — this is what CI runs
node diff-parse.mjs --self-test

# the real thing: compare against a LIVE dump (run this after upgrading dsh)
node diff-parse.mjs <dump.txt> --cli <dsh>/lib/bin.js
```

The live comparison needs a real dsh install, so CI runs the fixtures and the live form is documented
here instead of being faked in the workflow. Both print `SKIP` — never a false pass — when `yaml`
cannot be resolved, and say plainly that the run proves nothing.

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
if the ladder ran. `repair-report.md` is frequently **absent from the package** — the repair session
works inside `$DSH_HOME`, so its report normally lands in `$DSH_HOME\repair-<incident>\` and the
supervisor copies it back on a best-effort basis. That is why a missing report is a warning and not a
failure: the verdict is the boot probe.

**The ladder's verdict is a small table**, and `REPAIRED` is decided by the probe column, not the
report column — the two legitimately disagree:

```
| 级                        | 进程 | 报告                | 启动探针              | 判定     |
| L1 headless + 修复 overlay | ok   | NEEDS-HUMAN(无报告) | ALIVE（已 announce URL） | REPAIRED |
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
| Ladder ran but `repair-report.md` is missing | Expected and only a warning. The verdict is the boot probe in `boot-probe.log`; see the package layout above. |
| Launcher window closes instantly after a crash | By design once `DSH_NO_PAUSE=1` is set. Unset it to keep the window and read the gate's output in place. |
| `chcp`/mojibake: Chinese text looks doubled in the console | A console code-page artifact (CP936), not file corruption. The launcher already runs `chcp 65001`; if you invoke a script yourself, do the same. The files on disk are UTF-8. |
| Incident packages are in `<harness>\state\incidents` but the config says `<home>\state\incidents` | Two state roots, from a layout change on 2026-09-27. Point the config's `state` (or `incidents`) key at where your packages really are; the installer preserves both keys rather than overwriting them. |

Start from the two read-only commands in `repair/HOST-DOWN-README.md`; it is the same guidance a human
gets when every automatic rung has failed, and it never deletes anything.

## License

MIT
