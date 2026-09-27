# dsh-self-heal

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

Paths are constants at the top of each script:

| Constant | This checkout |
| --- | --- |
| harness root / launcher | `D:\dsh` |
| `$DSH_HOME` | `D:\dsh\home` |
| profiles | `$DSH_HOME\profiles\web`, `headless`, `rescue` |
| host log / gate log | `D:\dsh\dsh-console.log`, `$DSH_HOME\state\gate.log` |
| incident bundles | `$DSH_HOME\state\incidents\<timestamp>-exit<N>\` |
| repair probe port | 3081 |

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
```

| Switch | Meaning |
| --- | --- |
| `DSH_SKIP_GATE=1` | Skip the gate once |
| `DSH_NO_PAUSE=1` | Let the launcher window close by itself after a crash |
| `DSH_NO_REPAIR_AGENT=1` | Do not start the repair ladder automatically |
| `DSH_SUPERVISOR_RELAUNCH=1` | Allow one relaunch after a successful repair |
| `-GateOnly` | Run the gate and exit with its verdict |

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
self-heal-install.mjs           option-A installer: config, copy, wire, fallback profile, verify
launcher-integration.md         the launcher lines to add
```

An incident directory holds `summary.md`, `console-tail.txt`, `gate.txt`, `dump-config.txt`, `ladder.md`, `boot-probe.log`, `repair-live-<n>.log` and, when one was produced, `repair-report.md`.

## License

MIT
