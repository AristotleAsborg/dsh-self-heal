# dsh-self-heal

Startup gate, crash supervisor and bounded repair ladder for a DeepSeek Harness (DSH)
installation. Windows, Node 20+.

## What it does

| Stage | File | Behaviour |
| --- | --- | --- |
| L0-1 gate | `start-gate.mjs` | Composes the profile tree before launch and refuses to start on a **confirmed** inconsistency: a config key the installed module rejects, or an installed copy that has drifted from its source. Fails open — a missing gate file or an internal error only warns. |
| L0 supervisor | `host-supervisor.mjs` | On a non-zero host exit it writes an incident bundle (last 200 log lines, gate verdict, composed tree), classifies the failure, and performs the one allow-listed repair: re-sync the installed bundles (pnpm install), then re-check the gate. Never changes the launcher's exit code. |
| L1 / L1.5 repair | `incident-repair.mjs` | Hands the incident bundle to a bounded headless session — first `--profile headless`, then the factory `rescue` profile — under `repair/repair-overlay.yml`. Each rung runs at most once. |
| Fallback | `write-host-down-readme.mjs` | When every rung fails, copies `repair/HOST-DOWN-README.md` to a fixed path next to the launcher and appends the incident facts. |

## Requirements and expected layout

The scripts address a harness layout through constants at the top of each file:

| Constant | This checkout |
| --- | --- |
| harness root / launcher | `D:\dsh` |
| `$DSH_HOME` | `D:\dsh\home` |
| profiles | `$DSH_HOME\profiles\web`, `headless`, `rescue` |
| host log | `D:\dsh\dsh-console.log` |
| incident bundles | `D:\dsh\state\incidents\<timestamp>-exit<N>\` |

Edit those constants for a different layout. `pnpm` is used only by the re-sync repair;
without it that repair reports `failed` and nothing else happens.

## Install

1. Copy the `*.mjs` files to `<harness>\config\` and the `repair/` directory to `<harness>\config\repair\`.
2. Wire the gate and the supervisor into your launcher — see `launcher-integration.md`.
3. Create the factory fallback profile once:
   `node <dsh bin.js> rescue --from-default-profile headless --dump-config`

## Use

```powershell
# check consistency only, do not boot the host
<harness>\start-dsh.cmd -GateOnly

# hand the newest incident to the repair ladder
node <harness>\config\incident-repair.mjs --ladder
```

Switches: `DSH_SKIP_GATE=1` (skip the gate once), `DSH_SUPERVISOR_REPAIR_AGENT=1` (let the
supervisor start the repair ladder), `DSH_SUPERVISOR_RELAUNCH=1` (allow one relaunch after a
successful repair).

## Safety properties

- The gate fails open; the supervisor never changes the launcher exit code and never relaunches by default.
- The only automatic repair is a reversible `pnpm install` re-sync, and it re-checks the gate afterwards.
- The repair session runs with `workspace-write` rooted at `$DSH_HOME`, `approval: never`, telemetry and the session-log request field off; a write outside `$DSH_HOME` is denied by the sandbox.
- Loop guards: at most one repair per 10 minutes; every ladder rung runs at most once per incident.

## Files

```
start-gate.mjs              L0-1 startup gate
host-supervisor.mjs         L0 incident capture + allow-listed repair
incident-repair.mjs         L1 / L1.5 repair ladder + fallback trigger
write-host-down-readme.mjs  fixed-location operator guide writer
repair/repair-overlay.yml   policy for the repair session
repair/repair-prompt.md     repair contract (allow-list, reporting, stop conditions)
repair/HOST-DOWN-README.md  operator guide (Chinese)
repair/plumbing-test-prompt.md  harmless prompt used to test the plumbing
launcher-integration.md     the launcher lines to add
```

## License

MIT
