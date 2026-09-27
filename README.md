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

## License

MIT
