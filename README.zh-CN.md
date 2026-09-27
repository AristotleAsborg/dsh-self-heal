# dsh-self-heal

[![CI](https://github.com/AristotleAsborg/dsh-self-heal/actions/workflows/ci.yml/badge.svg)](https://github.com/AristotleAsborg/dsh-self-heal/actions/workflows/ci.yml)

[English](README.md) | 中文

给 DeepSeek Harness 用的启动闸门、崩溃看护与有界修复阶梯。Windows，Node 20+。

## 它能做什么

| 阶段 | 文件 | 行为 |
| --- | --- | --- |
| L0-1 启动闸门 | `start-gate.mjs` | 启动前组合 profile 树，只在**确证**不一致时拒绝启动：安装副本不接受某个配置键，或安装副本与源码漂移。内部错误一律放行——闸门文件缺失或自身出错只告警。判定追加到 `$DSH_HOME\state\gate.log`，该日志可写时也追加到宿主日志。 |
| L0 崩溃看护 | `host-supervisor.mjs` | 宿主非零退出时写事故包（日志尾部、闸门结论、组合树），只按**最后一次**启动尝试分类，并执行唯一在允许清单内的修复：重同步安装副本（`pnpm install`）后复验闸门。它不改启动器退出码，默认也不重启。摘要在任何长任务之前先落盘，所以被杀的运行也留得下。 |
| L1 / L1.5 修复阶梯 | `incident-repair.mjs` | 把事故交给一次有界的 headless 会话：先 `--profile headless`，起不来再降级到出厂 `rescue` profile，策略由 `repair/repair-overlay.yml` 给定。每一级都以 detached 方式运行、输出写进事故目录，所以关掉窗口既不会中断也不会抹掉它；控制台只是 tail 那个文件看进度。 |
| 判定 | `incident-repair.mjs` | 某级算"修好"的唯一依据是**启动探针**：把组合在备用端口 3081 上真启动一次并撑过硬超时。退出码不算证据；代理没写报告只记警告，不否决。 |
| 兜底 | `write-host-down-readme.mjs` | 所有级都没修好时，把 `repair/HOST-DOWN-README.md` 复制到启动器旁的固定位置，并追加本次事故的事实。 |

## 环境与目录约定

路径**不是**脚本里的硬编码常量：每个脚本都从 `self-heal.config.mjs` 取，而后者按
`环境变量 → <harness>\config\self-heal.config.json → 默认值` 的顺序解析。安装器把这份 JSON 写成
唯一事实来源，所以换一台机器只需重新跑一次安装器（或改这份 JSON），不必改代码。

| 键 / 取值 | 本机示例 |
| --- | --- |
| 安装根 `harnessRoot`（`--harness`） | `D:\dsh` |
| `$DSH_HOME`（`home`） | `D:\dsh\home` |
| 配置档 `profile` | `web` |
| 宿主日志 `log` / 闸门日志 `state\gate.log` | `D:\dsh\dsh-console.log`、`$DSH_HOME\state\gate.log` |
| 事故包 `incidents` | `$DSH_HOME\state\incidents\<时间戳>-exit<N>\` |
| 修复探针端口 `probePort` | 3081 |

可覆盖的环境变量：`DSH_SELFHEAL_HARNESS`（安装根）、`DSH_SELFHEAL_NODE`（node 解释器）。
其余键用 `DSH_SELFHEAL_<键名大写>` 覆盖，例如 `DSH_SELFHEAL_STATE`、`DSH_SELFHEAL_INCIDENTS`。

> **升级提示**：早于 2026-09-27 的版本把 `state` 与事故目录写在 `<harness>\state\` 下，
> 而 kit 配置默认指向 `$DSH_HOME\state\`。如果你有旧事故包留在 `<harness>\state\incidents\`，
> 在 JSON 里显式加一行 `"state"`（或 `"incidents"`）指向它即可；安装器会**保留**这两个键，不会覆盖。

`DSH_HOME` 会显式传给每一个子进程：启动器那条链的环境里没有它，不传的话 CLI 会静默地去组合**另一个安装**的 home。

## 安装

方式 A——用安装器（推荐）：

```powershell
node self-heal-install.mjs check      # 看解析出来的路径与缺什么
node self-heal-install.mjs install    # --harness <dir> --home <dir> --launcher <file>
```

`install` 会写 `<harness>\config\self-heal.config.json`（**所有路径都在那里**，脚本里不再硬编码布局）、
复制套件、给你自己的启动器接线（**只写 CRLF**、幂等、留 `.bak-selfheal-*` 备份），使**直接双击 `start-dsh.cmd`
就能唤醒闸门、看护与 L1 修复阶梯**（默认 `DSH_SUPERVISOR_REPAIR_AGENT=1`，`DSH_NO_REPAIR_AGENT=1` 可关）、
创建出厂兜底 profile，最后跑一次闸门作为交付验证。如果你的启动器不像 DSH 启动器，它**不会擅自修改**，
而是生成 `start-dsh-self-heal.cmd` 包装脚本。`uninstall` 用于摘掉接线块。

安装器是**幂等且会自我收敛**的：重复运行同一行字节不变；即使启动器被手改乱了
（例如接线块重复了若干份），它也会先把重复折叠成一份再退出。
`install` 只刷新它自己拥有的配置键，**你手工加进 JSON 的键会被保留并打印出来**，不会被覆盖。

改完启动器后建议直接验证一次（只读、不启动宿主）：

```powershell
$env:DSH_NO_PAUSE=1; cmd /c "D:\dsh\start-dsh.cmd -GateOnly"
```

顺带两个已修的坑：安装器此前用 `import.meta.url` 的 `.pathname` 取自身目录，
路径里只要有空格就会变成 `%20`，导致复制套件时 `ENOENT` 中断（**安装半途而废：配置已写、脚本没复制**）；
接线时查找 `start-dsh.ps1` 用的正则也会命中**注释行**，于是每跑一次就往文件里多插一个接线块。

方式 B——手工接线：

1. 把 `*.mjs` 复制到 `<harness>\config\`，把 `repair/` 复制到 `<harness>\config\repair\`。
2. 按 `launcher-integration.md` 接线。本机是：启动前跑闸门、宿主非零退出后跑看护，并默认设 `DSH_SUPERVISOR_REPAIR_AGENT=1`，崩溃无需第二个启动器就能进入修复阶梯。
3. 建一次出厂兜底 profile：`node <dsh bin.js> rescue --from-default-profile headless --dump-config`。

## 用法

```powershell
# 只做一致性检查，不启动宿主
<harness>\start-dsh.cmd -GateOnly

# 手动把最新事故交给修复阶梯
node <harness>\config\incident-repair.mjs --ladder
```

| 开关 | 含义 |
| --- | --- |
| `DSH_SKIP_GATE=1` | 单次跳过启动闸门 |
| `DSH_NO_PAUSE=1` | 崩溃后让启动窗口自己关闭 |
| `DSH_NO_REPAIR_AGENT=1` | 不自动启动修复阶梯 |
| `DSH_SUPERVISOR_RELAUNCH=1` | 修复成功后允许重启一次 |
| `-GateOnly` | 只跑闸门并以它的判定退出 |

## 安全性质

- 闸门是 fail-open 的：缺失或自身出错都不会拦住启动。
- 看护不改启动器退出码，默认不重启。
- 唯一的自动修复是可逆的 `pnpm install` 重同步，且修完必须复验闸门。
- 修复会话以 `workspace-write` 且以 `$DSH_HOME` 为界运行，`approval: never`，关闭 telemetry 与会话日志请求字段；越界写入会被沙箱拒绝，契约要求它**停下并报告**，而不是申请提权。
- 证据与窗口无关：每级 detached 运行、日志落在事故目录、判定文件每步重写。
- 循环护栏：10 分钟内最多修复一次；每个事故里每级最多跑一次。
- 修复会话内**起不了子进程**（沙箱拒绝），所以契约里的校验是文本级比对，而不是调用工具。

## 文件清单

```
start-gate.mjs                  L0-1 启动闸门
host-supervisor.mjs             L0 事故打包与允许清单内修复
incident-repair.mjs             L1 / L1.5 修复阶梯、启动探针与判定
write-host-down-readme.mjs      固定位置说明文档写入器
repair/repair-overlay.yml       修复会话的策略
repair/repair-prompt.md         修复契约：允许清单、报告路径、停止条件
repair/HOST-DOWN-README.md      人工排障说明
repair/plumbing-test-prompt.md  管道自检用的无害提示词
self-heal.config.mjs            统一路径解析（env → 配置文件 → 默认值）
self-heal-install.mjs           选项 A 安装器：配置、复制（含 repair\）、接线、兜底档、交付验证
launcher-integration.md         启动器要加的接线
```

`repair\HOST-DOWN-README.md` 里用 `{{HARNESS}}` `{{HOME}}` `{{INCIDENTS}}` `{{CLI}}` 这类占位符代替写死的路径，
由 `write-host-down-readme.mjs` 在写盘时按当前配置替换（未知占位符会原样保留并告警）。
这样同一份源文件在任何安装布局下给出的都是**正确**路径——之前写死的版本在 state 根目录变更后会指错地方。

事故目录里会有 `summary.md`、`console-tail.txt`、`gate.txt`、`dump-config.txt`，以及产出过的 `ladder.md`、
`boot-probe.log`、`repair-live-<n>.log`、`repair-report.md`。**它们不是每次都齐**：`gate.txt`/`console-tail.txt`/`dump-config.txt`
基本总在，而 `ladder.md` 只有跑过阶梯的事故才有，`repair-report.md` 更是常常没有（修复会话的工作区是 `$DSH_HOME`，
报告通常写在 `$DSH_HOME\repair-<事故>\` 下，看护会尝试回拷一份）。所以**别用"文件齐备"当判据**。

## 测试与 CI

`.github/workflows/ci.yml` 跑在 **Windows** 上（本套件每个脚本都依赖 cmd.exe 批处理语义、
只能 CRLF 的启动器文件和原生 `pnpm.exe`——换 Linux runner 测的就是另一个程序了），做四件事：

1. **逐个解析所有出货脚本**：本仓库没有构建步骤，否则语法错误没有任何东西会发现；
2. **把套件目录与安装器的复制清单双向比对**：安装器用的是显式清单，往目录里加文件**不等于**会被安装——
   `repair\` 就曾经一个都没被复制，而配置正指向它里面的文件；
3. **跑 `ci-test.mjs`**：55 项检查，端到端驱动真实的安装器；
4. **拒绝代码里出现机器相关路径**（注释除外；那几个有文档、可覆盖的默认值按原文白名单放行）。

`ci-test.mjs` 刻意不是单元测试。它在一个**路径含空格**的临时 harness 上真装一遍、断言每个声明的文件
逐字节到位、给启动器接线，然后**再装一遍**证明第二次是空操作；还会故意把启动器改乱，证明重跑是把它
折叠回一份、而不是继续变长。当初最要命的两个失效模式（`%20` 路径让复制整个失败、接线每跑一次就变长）
在普通检出目录上只跑一次**都看不见**——这正是它们能活到"换台机器跑一次"才暴露的原因。

本机跑它不需要 dsh CLI：

```powershell
node ci-test.mjs
```

**CI 刻意不覆盖**（要碰它必须有真实 dsh 安装）：闸门对"组合出来的行、其配置被安装副本拒绝"的拦截。
那条路径在真机上验证过——见本套件为之而生的那次事故。

## 许可证

MIT
