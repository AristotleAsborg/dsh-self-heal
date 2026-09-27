# 宿主起不来时怎么办（通用说明）

> 这份文档由**固定脚本** `{{CONFIG_DIR}}\write-host-down-readme.mjs` 放到这个位置，
> 出现它就意味着：**启动前闸门、看护脚本、L1 修复会话、L1.5 出厂 profile 四级都没能把宿主救回来**。
> 源文件在 `{{CONFIG_DIR}}\repair\HOST-DOWN-README.md`（本文末尾会追加本次事故的要点）。
>
> 原则：**先只读、再动手；每一步都可回滚；不要删任何东西**（尤其 `{{INCIDENTS}}\` 和 `*.bak-*`）。

## 0. 先拿两条只读信息（不动任何东西）

```powershell
# ① 启动前闸门：它会把"确证不一致"的项直接点出来（含修复命令）
{{LAUNCHER}} -GateOnly

# ② 最近一次事故包（含故障原文、闸门结论、组合树）
Get-ChildItem {{INCIDENTS}} | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content {{LOG}} -Tail 60
```

## 1. 闸门拦停（最常见，也最好修）

闸门只拦**确证**不一致，输出里每一条 `[FAIL]` 后面都跟着 `→ 修复命令`。典型两类：

| 症状 | 修法 |
| --- | --- |
| `行 X（包名）配置被安装副本拒绝：unknown config key "K"` | 把该键从该行 config 里删掉（或禁用该行），再跑 `-GateOnly` 确认 |
| `安装副本与源码不一致：包\文件` | 在 `{{PROFILE_DIR}}` 里跑 `pnpm install`，再跑 `-GateOnly` |

**只想先进去看一眼**（不做任何修复）：在同一窗口里 `set DSH_SKIP_GATE=1` 然后再启动——这一次会跳过闸门。

## 2. 宿主起来又立刻退出

看最新事故目录里的 `summary.md`：它写明**分类**、闸门结论、以及看护脚本已经做过的动作。
`console-tail.txt` 里有报错原文（**先逐字引用它再下结论**，不要凭印象）。

## 3. 手动降级顺序（从轻到重，每步只做一件事）

1. **只干净地看一眼组合**（不启动任何东西）：
   ```powershell
   node {{CLI}} --profile {{PROFILE}} --patch {{HOME_PATCH}} --dump-config > $env:TEMP\composed.yml
   ```
2. **怀疑本地插件**：把 `{{PROFILE_DIR}}\package.json` 的 `dsh.profile.bundles` 里那个包名**临时移到行尾注释掉**（先备份该文件），再启动。
3. **怀疑 `$DSH_HOME` 覆盖层**：把 `{{HOME_PATCH}}` 临时改名（如 `+ .disabled`），启动器仍会照常起——覆盖层没了就回到出厂行为。
4. **用出厂 profile 起一次**（template 是出厂模板，不受你改动影响）：
   ```powershell
   node {{CLI}} --profile rescue {{PROFILE}} --no-open --port 3081
   ```
   （`rescue` 是 2026-09-27 用 `rescue --from-default-profile headless` 建的；若你要干净的 web UI，
   另外建一个：`... rescue2 --from-default-profile web --dump-config` 先只创建。）

## 4. 恢复备份

```powershell
# 列出 $DSH_HOME 下所有备份（按时间）
Get-ChildItem {{HOME}} -Recurse -Filter '*.bak-*' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 20 FullName
# 启动器本身的备份（2026-09-27 加闸门/看护之前的那份）
Get-ChildItem {{HARNESS}} -Filter 'start-dsh.cmd.bak-*'
```

## 5. 把启动链改动整体摘掉（回到"裸启动器"）

```powershell
Copy-Item (Get-ChildItem {{HARNESS}} -Filter 'start-dsh.cmd.bak-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName {{LAUNCHER}} -Force
```

（也可以只删 `{{CONFIG_DIR}}\start-gate.mjs` 或 `{{CONFIG_DIR}}\host-supervisor.mjs`：启动器发现文件缺失会**警告后继续启动**，不会因为缺文件而拒绝起。）

## 6. 求援时带什么

把**整个最新事故目录**（`{{INCIDENTS}}\<时间戳>-exit<N>\`）连同 `{{LOG}}` 一起带走，
并在求助信息里写：`-GateOnly` 的输出、`summary.md` 的分类、你已经试过第 3 节里的哪几步。
**不要删任何东西**——被删掉的证据无法重建。

<!--
本文件里的 {{...}} 占位符由 write-host-down-readme.mjs 在写盘时替换成配置里的真实路径
（见 self-heal.config.mjs）。这样同一份源文件在任何安装布局下都能给出**正确**的路径，
而不是把某个人的 D:\dsh 写死进来 —— 之前写死的版本在 state 根目录变更后会指错地方。
可用占位符：{{HARNESS}} {{HOME}} {{CONFIG_DIR}} {{INCIDENTS}} {{LOG}} {{LAUNCHER}} {{CLI}} {{PROFILE}} {{PROFILE_DIR}} {{HOME_PATCH}}
-->
