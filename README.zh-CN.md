# dsh-self-heal

**v0.1.4** · [![CI](https://github.com/AristotleAsborg/dsh-self-heal/actions/workflows/ci.yml/badge.svg)](https://github.com/AristotleAsborg/dsh-self-heal/actions/workflows/ci.yml)

[English](README.md) | 中文

给 DeepSeek Harness 用的启动闸门、崩溃看护与有界修复阶梯。Windows，Node 20+。

版本写在 [`VERSION`](VERSION) 里，那是它**唯一**的落笔处；一次发布 = 该文件 + 一个对应的
`git tag v<version>`。本项目没有构建步骤、也没有包清单，所以没有别的东西需要跟它对齐。

**它会自己启动——你不需要调用任何东西。** 装好之后，整条链路接在你**原有的启动器**上，无人在场也照跑：

- **每次启动之前**，闸门先检查组合，遇到**确证**不一致就拒绝启动。
- **宿主非零退出时，看护自己启动。** 所有失败路径最终都汇到启动器的退出码上，所以一次崩溃——
  窗口一闪而过、升级装坏、插件加载不了——就足以触发它。不需要第二个启动器、不需要手动步骤、
  也不需要有人守着控制台。
- **修复阶梯随后也自己启动**（安装器默认就设 `DSH_SUPERVISOR_REPAIR_AGENT=1`），把证据交给一次
  有界的 headless 会话，全程不碰你自己的启动器。

下面各节讲的就是这些自动步骤做什么、以及怎么读它们的输出。唯一的例外写在「安全性质」里：
修复是有界的，修不动就停，不会反复重启。

## 与哪些版本兼容

**它包的是 `dsh` 命令行，所以只要 DSH 的 CLI 保持它用到的那几个接口，就能用。** 这个面很小、
很稳；具体验到哪一步，下面逐条写明，不靠默认假设。

| 对象 | 状态 |
| --- | --- |
| `dsh` CLI `0.1.6-alpha.2` | 本套件开发与实测所用的版本 |
| `dsh` CLI `0.1.7-rc.2` | **兼容** —— 通过对比两个发布版验得，见下 |
| **官方桌面端（Electron）** | **不支持。** 它有自己的启动器与生命周期，且 CLI 明确拒绝它的 profile，见下 |

它只用到这么点东西，所以版本变更很少能碰到它：

- **只有六个 CLI 入口**：`--profile`、`--patch`、`--dump-config`、`--from-default-profile`、
  `--help`、`--version`。套件**从不 import** DSH 的内部模块，所以内部怎么动都不影响它。
- **`--dump-config` 的 YAML**（闸门手写解析的那份）。这是唯一真正的耦合，所以直接对比过：
  `@deepseek-ai/dsh-app-boot` 里的 `renderConfigDump`、`groupedDump` 与 `!!js` schema 类型在两个
  版本间**逐字节相同**。dump 格式没有变。
- **你的 profile 结构**：带 `dsh.profile.bundles` 的 `package.json`，加上 `cordis.patch.yml` 层，
  按这个顺序。两个版本之间未变。
- **你的本地插件**：它们**没有声明任何 DSH peer 范围**，所以 0.1.7 新增的"插件/运行时兼容门禁"
  对它们不生效——那道门禁只检查**确实声明了** `peerDependencies` 的清单。

### 桌面端是另一个入口，不是另一个版本

官方桌面端是 Electron，复用同一套 Web UI 与 agent/session/plugin 逻辑，但它由**自己的应用**启动，
而不是由 `dsh` 启动；CLI 把 `desktop` 这个 profile **留给它**：

```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

这是**出货 CLI 自己的守卫**，不是我的推断。官方在 `deepseek-ai/deepseek-harness` 仓库里
`apps/desktop` 的文档写清了其余部分——这是**刻意的隔离**，不是遗漏：

- 桌面端就是 `apps/desktop`，包名 `@deepseek-ai/dsh-desktop`，**`"private": true`**——
  所以 npm 上没有这个包，它以安装包形式从 `download.deepseek.com` 分发。
- Electron 以 RunAsNode 子进程启动**共享的 profile runner**；签名应用从 `resources/app.asar/dsh`
  提供内置的 `dsh` 及其生产依赖。所以它的 profile **只安装外部插件**。
- Electron 会取**进程生命周期单实例锁**，并**独占 `$DSH_HOME/profiles/desktop`** 及其包管理器状态。
  用官方原话：CLI 与 Desktop "共享 `$DSH_HOME` 下受支持的产品数据，但**绝不共享**可执行包、
  插件激活、锁文件或 `node_modules`"，且"**CLI 不能启动或修改此 profile**"。
- 桌面端默认监听端口 **19387**，与 Web 的 `3080` 分开。

它对本套件有两层结构性影响：

1. 闸门在 CLI 启动**之前**跑，看护在**启动器退出码**上跑。Electron 应用把这两个时机都自己占了——
   而且它**自带**致命启动失败的恢复对话框（重启、禁用第三方插件、备份 profile patch 后重启）。
   所以本套件**没有插入点**，它也不会去包一个 GUI 应用的启动流程。
2. 把本套件指向 desktop profile **不可能工作**：它调的每一条命令都会被上面那道守卫拒绝。
   这一点不需要你自己踩一遍——**别把 `profile` 设成 `"desktop"`**（安装器会直接拒绝并说明原因）。

**但两者确实共享一样东西，要当心。** 桌面端与 CLI 共享 `$DSH_HOME`，而 home 层的
`$DSH_HOME/cordis.patch.yml` 在 CLI 组合树时**会被应用**——我在本机实测过：把它移走后重新 dump，
组合结果变了（656 行 → 636 行）。桌面端的 profile 也保留同一个 home patch。所以如果你**同时**
装了本套件又在同一个 home 上跑桌面端，请把**那一个文件当成共享状态**：
修复会话被允许编辑它，而写在那里的改动**不会**只作用于你的 CLI profile。
这条是按**风险提示**记录的，不是在声明本套件能管桌面端——它管不了。

跑桌面端的话，请把本套件对着你的 **CLI 安装**（`dsh` / `dsh web`）单独用。两者可以共存，
它们是**两套独立生命周期**。

**覆盖边界**：上面的 CLI 兼容结论来自两个发布版的**契约、发射器与守卫的直接对比**（从 tarball 里读出来的），
**不是**把套件在 0.1.7 上端到端跑过一遍。桌面端那些事实来自官方仓库 `apps/desktop` 的文档与清单，
但**本套件从未在桌面端上运行过**——本机没有安装任何桌面端构建，没有可运行的对象。

## 它能做什么

| 阶段 | 文件 | 行为 |
| --- | --- | --- |
| L0-1 启动闸门 | `start-gate.mjs` | 启动前组合 profile 树，只在**确证**不一致时拒绝启动：安装副本不接受某个配置键，或安装副本与源码漂移。内部错误一律放行——闸门文件缺失或自身出错只告警。判定追加到 `$DSH_HOME\state\gate.log`，该日志可写时也追加到宿主日志。 |
| L0 崩溃看护 | `host-supervisor.mjs` | **宿主非零退出时自动运行。** 写事故包（日志尾部、闸门结论、组合树），只按**最后一次**启动尝试分类，并执行唯一在允许清单内的修复：重同步安装副本（`pnpm install`）后复验闸门。它不改启动器退出码。修复**被证实**后它会重启一次（每 10 分钟最多一次；用 `DSH_NO_RELAUNCH=1` 关掉）。摘要在任何长任务之前先落盘，所以被杀的运行也留得下。 |
| L1 / L1.5 修复阶梯 | `incident-repair.mjs` | **在看护之后自动启动**，把事故交给一次有界的 headless 会话：先 `--profile headless`，起不来再降级到出厂 `rescue` profile，策略由 `repair/repair-overlay.yml` 给定。每一级都以 detached 方式运行、输出写进事故目录，所以关掉窗口既不会中断也不会抹掉它；控制台只是 tail 那个文件看进度。 |
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

# 只看阶梯"会做什么"，不启动任何东西（不花 token）
node <harness>\config\incident-repair.mjs --dry-run

# 只收证据就停，不尝试修复
node <harness>\config\incident-repair.mjs --no-ladder
```

| 开关 | 含义 |
| --- | --- |
| `DSH_SKIP_GATE=1` | 单次跳过启动闸门 |
| `DSH_NO_PAUSE=1` | 崩溃后让启动窗口自己关闭 |
| `DSH_NO_REPAIR_AGENT=1` | 不自动启动修复阶梯 |
| `DSH_SELFHEAL_TRUST_L0=1` | L0 干净重同步且闸门通过后，跳过阶梯（省一次调用） |
| `DSH_NO_RELAUNCH=1` | 修复被证实后也不自动重启 |
| `-GateOnly` | 只跑闸门并以它的判定退出 |
| `--dry-run`（阶梯） | 只做计划：**不**启动会话、**不**跑探针，因此不花 token |
| `--no-ladder`（阶梯） | 只收集证据就停：一级都不跑 |

### L0 与 L1 是级联的，而且判据不是闸门

L0（唯一在允许清单内的 `pnpm install` 重同步）与 L1（有界修复阶梯）原本是**互斥分支**：
有漂移就只走 L0。这让阶梯在最需要它的情形下**根本进不去**——**有漂移、而重同步又消不掉**。
现在两者级联。

**宿主非零退出**且 L0 没能证明修好时，阶梯就会跑。注意**不是**判据的那个东西：
**闸门通过不等于宿主能起来。** 闸门是刻意 fail-open 的，凡是它验证不了的一律沉默——
2026-09-27 实测：某插件入口有语法错误（源码与安装副本逐字节相同，因此没有漂移可报），
闸门给出 `PASS`，而宿主**根本起不来**。所以拿闸门判定当阶梯的门禁，恰好会在闸门瞎掉的时候把它关掉。

唯一可靠的事实是：**宿主已经非零退出了**——看护就是因此才在跑。所以阶梯是默认行为，
跳过它才是显式选择：`DSH_SELFHEAL_TRUST_L0=1` 表示"干净重同步后我信这个结果，别再花一次调用"。
**该跑没跑**的代价是留下一个起不来的宿主；**不该跑却跑了**的代价只是一次调用。

### 它会把宿主重新拉起来

L1 和 L0 的结局是同一条：**修复被证实后，宿主会被自动重启。**"被证实"指阶梯的启动探针
返回 ALIVE，或 L0 重同步之后闸门通过。若修复没被证实、闸门当前拒绝启动、或设了
`DSH_NO_RELAUNCH=1`，看护会把原因写进报告，把宿主留给人处理。

默认开启，是因为"不重启"的后果是实测过的：套件把宿主修好了、报告写了成功，
然后**把它留在关闭状态**，于是必须由人自己注意到并手动重启。
重启被限制为**每个冷却窗口内一次**（记在 `attempts.json`），所以不会变成崩溃循环——
第二次启动若再失败，会落进与第一次相同的受控路径。


## 安全性质

- 闸门是 fail-open 的：缺失或自身出错都不会拦住启动。
- 看护不改启动器退出码，且**只在修复被证实后**重启，每个冷却窗口最多一次。
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
只能 CRLF 的启动器文件和原生 `pnpm.exe`——换 Linux runner 测的就是另一个程序了），查四件事：
所有出货脚本能解析、套件目录与安装器复制清单一致、安装器端到端可用、代码里没有机器相关路径。

本机跑端到端，不需要 dsh CLI：

```powershell
node ci-test.mjs                  # 拿真安装器在临时 harness 上跑一遍
node diff-parse.mjs --self-test    # 组合树读取器 vs 真正的 yaml 包
```

两套都在**路径含空格**的临时 harness 上验证，且安装器要**连跑两次**（第二次必须是空操作）。
这不是装饰：最要命的几个失效模式在普通路径上只跑一次**根本看不见**。
但两套都不能替代"真启动宿主一次"——见下面的「正常运转的表现」。

为什么这样测、每条检查抓到过什么，记在交接文档里，不写在这份 README。

## 正常运转的表现

下面每条都是**实测样例**，不是示意图。先拿它当"这套装置是不是健康的"参照，再去看排查表。

**闸门每次运行往 `$DSH_HOME\state\gate.log` 追加恰好一行**：

```
[gate] PASS 2026-09-27T12:31:52.356Z failures=0 warnings=1
```

关键是 `failures=0`。`warnings=1` 通常就是"端口 3080 已被 PID … 占用"这条提示——只要宿主已经开着，
它就正常。出现 `failures=<n>` 才是闸门**拒绝启动**；同一次运行的标准输出会逐条点名失败项，
并在每条下面打印修法。

**健康的启动会 announce 自己的 URL 并留在那儿。** 实测约一秒：

```
dsh web: http://127.0.0.1:3080/?token=…
```

这一行是唯一可靠的"它起来了"信号。退出码给不出这个信息——所以本套件的判定一律是**启动探针**，
而不是返回值。

**"某一行是好的"这种输出是要读的，不是噪音**：

```
[PASS] 组合树可解析（dump-config 成功）
[PASS] 行 selfheal（dsh-plugin-selfheal）的配置被安装副本接受：{"enabled":true,"allowRepair":false}
[PASS] 未发现确证不一致 —— 允许启动
```

注意第二种形态：闸门会**导入每个已安装的本地包、用组合出来的 config 调它的 `resolvePolicy`**。
不导出 `resolvePolicy` 的包则会得到下面这条——闸门如实说明自己的覆盖面，而不是暗示自己查过了：

```
[WARN] 没有任何本地包导出 resolvePolicy —— 本次只做了字节一致性检查（覆盖面有限，如实记录）
```

**看护每个事故记一行**到 `$DSH_HOME\state\supervisor.log`：

```
[supervisor] incident=…\20260927110428-exit4 classes=entry-failure actions=3 2026-09-27T11:07:15.486Z
```

**事故包的文件不是齐的**——别拿"文件齐备"当判据。一个真实的、成功的事故包：

```
boot-probe.log  console-tail.txt  dump-config.txt  gate.txt
ladder.md  ladder-live.log  repair-live-1.log  repair-task.txt  summary.md
```

`gate.txt`、`console-tail.txt`、`dump-config.txt` 基本总在；`ladder.md` 只有跑过阶梯才有
（只做过 L0 修复的事故包这两样都没有）。修复会话按契约把报告写到 `$DSH_HOME`，因为事故目录
在它的工作区之外，所以看护会**同时**找 `$DSH_HOME\repair-<事故>.md` 和
`$DSH_HOME\repair-report.md`，找到哪个就回拷进包里。报告缺失只记警告、不算失败：
判定依据是启动探针。

**阶梯的判定是一张小表**，`REPAIRED` 由**启动探针**那一列决定，而不是报告列——两列不一致是正常的：

```
| 级                        | 进程 | 报告                     | 启动探针                 | 判定     |
| L1 headless + 修复 overlay | ok   | D:\dsh\home\repair-….md | ALIVE（已 announce URL） | REPAIRED |
```

## 排查

| 症状 | 含义与做法 |
| --- | --- |
| `[dsh] startup gate REFUSED to launch` | 最常见也最好修。每条 `[FAIL]` 后面都跟着 `→ <修复命令>`，照着跑再 `-GateOnly` 复验。只想先进去一次：`set DSH_SKIP_GATE=1`。 |
| `行 X（包名）配置被安装副本拒绝：unknown config key "K"` | 组合出来的 config 带了一个安装副本不接受的键。装载器把"条目失败"当致命错误，所以宿主会在启动一秒内退出。把该键从这一行的 `config` 里删掉（或禁用该行），再用 `-GateOnly` 复验。 |
| `安装副本与源码不一致：包\文件` | 安装副本与源码漂移了。在 `<home>\profiles\<配置档>` 里跑 `pnpm install`（或让看护的 `pnpm install` 去做），然后复验。 |
| `组合失败：…` | 组合这棵树本身就失败了——下一次启动会撞上同一件事。闸门会拒绝并打印绕过方式。**先读完整报错原文**，不要默认是闸门自己的问题。 |
| 宿主启动后一秒内退出 | 打开最新事故包里的 `console-tail.txt`，**逐字引用报错再下结论**。装载器里一个条目失败即致命，所以真正的起因通常就是它最后点名的那一行。 |
| `incident-repair: 没有事故目录（…）` | 没有可修的事故。退出码 2，什么都没尝试。不是错误。 |
| 阶梯跑过，但包里没有 `repair-report.md` | 只记警告。判定依据是 `boot-probe.log` 里的启动探针；会话把报告写在 `$DSH_HOME`，所以也去那里找 `repair-<事故>.md`——看护找到就会回拷进包里。 |
| 崩溃后启动窗口瞬间关闭 | 设了 `DSH_NO_PAUSE=1` 就会这样（设计如此）。去掉它，窗口会留住，闸门输出就能在原地看。 |
| 控制台里中文"像印了两遍" | 控制台代码页（CP936）造成的显示问题，**不是文件坏了**。启动器里已经有 `chcp 65001`；你自己直接调脚本时也先跑一次它。磁盘上是 UTF-8。 |
| 事故包在 `<harness>\state\incidents`，而配置写的是 `<home>\state\incidents` | 两个 state 根。包落到哪里由配置的 `state` 与 `incidents` 两个键决定，把它们指向你事故包真实所在即可。安装器现在**保留**你配置的值（`incidents` 默认跟随 `state`），不再从 `<home>` 重新推导。 |

先跑 `repair/HOST-DOWN-README.md` 里那两条只读命令——那就是自动四级全败之后给人看的同一份指引，
而且它不删任何东西。

## 许可证

MIT
