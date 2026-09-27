# dsh-self-heal

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

路径是每个脚本顶部的常量：

| 常量 | 本机取值 |
| --- | --- |
| 安装根 / 启动器 | `D:\dsh` |
| `$DSH_HOME` | `D:\dsh\home` |
| 配置档 | `$DSH_HOME\profiles\web`、`headless`、`rescue` |
| 宿主日志 / 闸门日志 | `D:\dsh\dsh-console.log`、`$DSH_HOME\state\gate.log` |
| 事故包 | `$DSH_HOME\state\incidents\<时间戳>-exit<N>\` |
| 修复探针端口 | 3081 |

`DSH_HOME` 会显式传给每一个子进程：启动器那条链的环境里没有它，不传的话 CLI 会静默地去组合**另一个安装**的 home。

## 安装

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
launcher-integration.md         启动器要加的接线
```

事故目录里会有 `summary.md`、`console-tail.txt`、`gate.txt`、`dump-config.txt`、`ladder.md`、`boot-probe.log`、`repair-live-<n>.log`，以及产出过报告时的 `repair-report.md`。

## 许可证

MIT
