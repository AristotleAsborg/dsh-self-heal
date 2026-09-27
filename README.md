# dsh-self-heal

**English** — Startup gate, crash supervisor and a bounded repair ladder for a DeepSeek Harness (DSH) installation. Windows, Node 20+.

**中文** —— DeepSeek Harness（DSH）的启动闸门、崩溃看护与有界修复阶梯。Windows，Node 20+。

## What it does / 它能做什么

| Stage 阶段 | File 文件 | Behaviour 行为 |
| --- | --- | --- |
| L0-1 gate 启动闸门 | `start-gate.mjs` | Composes the profile tree before launch and refuses to start on a **confirmed** inconsistency: a config key the installed module rejects, or an installed copy that has drifted from its source. Fails open — a missing gate file or an internal error only warns.<br>启动前组合 profile 树，只在**确证**不一致时拒绝启动（安装副本不接受某个配置键、或安装副本与源码漂移）。内部错误一律放行：闸门文件缺失或自身出错只告警，不会拦住启动。 |
| L0 supervisor 崩溃看护 | `host-supervisor.mjs` | On a non-zero host exit it writes an incident bundle (last 200 log lines, gate verdict, composed tree), classifies the failure, and performs the one allow-listed repair: re-sync the installed bundles (`pnpm install`), then re-check the gate. It never changes the launcher's exit code and never relaunches by default.<br>宿主非零退出时写事故包（日志最后 200 行、闸门结论、组合树），对故障分类，并执行**唯一在允许清单内**的修复：重同步安装副本（`pnpm install`）后复验闸门。它不改启动器退出码，默认也不重启。 |
| L1 / L1.5 repair 修复阶梯 | `incident-repair.mjs` | Hands the incident bundle to a bounded headless session — first `--profile headless`, then the factory `rescue` profile — under `repair/repair-overlay.yml`. Each rung runs at most once; a rung that cannot even boot escalates to the next.<br>把事故包交给一次有界的 headless 会话：先 `--profile headless`，起不来再降级到出厂 `rescue` profile，策略由 `repair/repair-overlay.yml` 给定。每级最多跑一次；某级"起不来"就降级。 |
| Fallback 兜底 | `write-host-down-readme.mjs` | When every rung fails, copies `repair/HOST-DOWN-README.md` to a fixed path next to the launcher and appends the incident facts.<br>所有级都失败时，把 `repair/HOST-DOWN-README.md` 复制到启动器旁的固定位置，并追加本次事故的事实（分级结果、摘要、报错尾部）。 |

## Requirements and expected layout / 环境与目录约定

The scripts address a harness layout through constants at the top of each file:
脚本通过每个文件顶部的常量定位 harness 目录：

| Constant 常量 | This checkout 本机取值 |
| --- | --- |
| harness root / launcher 安装根 / 启动器 | `D:\dsh` |
| `$DSH_HOME` | `D:\dsh\home` |
| profiles 配置档 | `$DSH_HOME\profiles\web`, `headless`, `rescue` |
| host log 宿主日志 | `D:\dsh\dsh-console.log` |
| incident bundles 事故包 | `D:\dsh\state\incidents\<timestamp>-exit<N>\` |

Edit those constants for a different layout. `pnpm` is used only by the re-sync repair; without it that repair reports `failed` and nothing else happens.
换目录时改这些常量即可。`pnpm` 只被"重同步"这一条修复用到；没装它时那条修复会如实报 `failed`，不产生其他影响。

## Install / 安装

1. Copy the `*.mjs` files to `<harness>\config\` and the `repair/` directory to `<harness>\config\repair\`.
   把 `*.mjs` 复制到 `<harness>\config\`，把 `repair/` 复制到 `<harness>\config\repair\`。
2. Wire the gate and the supervisor into your launcher — see `launcher-integration.md`.
   按 `launcher-integration.md` 把闸门与看护接进启动器。
3. Create the factory fallback profile once:
   建一次出厂兜底 profile：
   `node <dsh bin.js> rescue --from-default-profile headless --dump-config`

## Use / 用法

```powershell
# check consistency only, do not boot the host / 只做一致性检查，不启动宿主
<harness>\start-dsh.cmd -GateOnly

# hand the newest incident to the repair ladder / 把最新事故交给修复阶梯
node <harness>\config\incident-repair.mjs --ladder
```

| Switch 开关 | Meaning 含义 |
| --- | --- |
| `DSH_SKIP_GATE=1` | Skip the gate once / 单次跳过启动闸门 |
| `DSH_SUPERVISOR_REPAIR_AGENT=1` | Let the supervisor start the repair ladder / 允许看护拉起修复阶梯 |
| `DSH_SUPERVISOR_RELAUNCH=1` | Allow one relaunch after a successful repair / 修复成功后允许重启一次 |

## Safety properties / 安全性质

- The gate fails open; a missing or broken gate never blocks a launch.
  闸门是 fail-open 的：缺失或自身出错都不会拦住启动。
- The supervisor never changes the launcher exit code and never relaunches by default.
  看护不改启动器退出码，默认不重启。
- The only automatic repair is a reversible `pnpm install` re-sync, and it re-checks the gate afterwards.
  唯一的自动修复是可逆的 `pnpm install` 重同步，且修完必须复验闸门。
- The repair session runs with `workspace-write` rooted at `$DSH_HOME`, `approval: never`, telemetry and the session-log request field off; a write outside `$DSH_HOME` is denied by the sandbox.
  修复会话以 `workspace-write` 且以 `$DSH_HOME` 为界运行，`approval: never`，关闭 telemetry 与会话日志请求字段；越界写入会被沙箱拒绝。
- Loop guards: at most one repair per 10 minutes; every ladder rung runs at most once per incident.
  循环护栏：10 分钟内最多修复一次；每个事故里每级最多跑一次。

## Files / 文件清单

```
start-gate.mjs                  L0-1 startup gate / 启动闸门
host-supervisor.mjs             L0 incident capture + allow-listed repair / 事故打包与允许清单内修复
incident-repair.mjs             L1 / L1.5 repair ladder + fallback trigger / 修复阶梯与兜底触发
write-host-down-readme.mjs      fixed-location operator guide writer / 固定位置说明文档写入器
repair/repair-overlay.yml       policy for the repair session / 修复会话的策略
repair/repair-prompt.md         repair contract (allow-list, reporting, stop conditions) / 修复契约
repair/HOST-DOWN-README.md      operator guide (Chinese) / 人工排障说明
repair/plumbing-test-prompt.md  harmless prompt used to test the plumbing / 管道自检提示词
launcher-integration.md         the launcher lines to add / 启动器要加的接线
```

## License / 许可证

MIT
