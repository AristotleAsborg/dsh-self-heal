# 宿主起不来时怎么办（通用说明）

> 这份文档由**固定脚本** `D:\dsh\config\write-host-down-readme.mjs` 放到这个位置，
> 出现它就意味着：**启动前闸门、看护脚本、L1 修复会话、L1.5 出厂 profile 四级都没能把宿主救回来**。
> 源文件在 `D:\dsh\config\repair\HOST-DOWN-README.md`（本文末尾会追加本次事故的要点）。
>
> 原则：**先只读、再动手；每一步都可回滚；不要删任何东西**（尤其 `D:\dsh\state\incidents\` 和 `*.bak-*`）。

## 0. 先拿两条只读信息（不动任何东西）

```powershell
# ① 启动前闸门：它会把"确证不一致"的项直接点出来（含修复命令）
D:\dsh\start-dsh.cmd -GateOnly

# ② 最近一次事故包（含故障原文、闸门结论、组合树）
Get-ChildItem D:\dsh\state\incidents | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content D:\dsh\dsh-console.log -Tail 60
```

## 1. 闸门拦停（最常见，也最好修）

闸门只拦**确证**不一致，输出里每一条 `[FAIL]` 后面都跟着 `→ 修复命令`。典型两类：

| 症状 | 修法 |
| --- | --- |
| `行 X（包名）配置被安装副本拒绝：unknown config key "K"` | 把该键从该行 config 里删掉（或禁用该行），再跑 `-GateOnly` 确认 |
| `安装副本与源码不一致：包\文件` | 在 `D:\dsh\home\profiles\web` 里跑 `pnpm install`，再跑 `-GateOnly` |

**只想先进去看一眼**（不做任何修复）：在同一窗口里 `set DSH_SKIP_GATE=1` 然后再启动——这一次会跳过闸门。

## 2. 宿主起来又立刻退出

看最新事故目录里的 `summary.md`：它写明**分类**、闸门结论、以及看护脚本已经做过的动作。
`console-tail.txt` 里有报错原文（**先逐字引用它再下结论**，不要凭印象）。

## 3. 手动降级顺序（从轻到重，每步只做一件事）

1. **只干净地看一眼组合**（不启动任何东西）：
   ```powershell
   node D:\dsh\runtime\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile web --patch D:\dsh\home\cordis.patch.yml --dump-config > $env:TEMP\composed.yml
   ```
2. **怀疑本地插件**：把 `D:\dsh\home\profiles\web\package.json` 的 `dsh.profile.bundles` 里那个包名**临时移到行尾注释掉**（先备份该文件），再启动。
3. **怀疑 `$DSH_HOME` 覆盖层**：把 `D:\dsh\home\cordis.patch.yml` 临时改名（如 `+ .disabled`），启动器仍会照常起——覆盖层没了就回到出厂行为。
4. **用出厂 profile 起一次**（template 是出厂模板，不受你改动影响）：
   ```powershell
   node D:\dsh\runtime\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile rescue web --no-open --port 3081
   ```
   （`rescue` 是 2026-09-27 用 `rescue --from-default-profile headless` 建的；若你要干净的 web UI，
   另外建一个：`... rescue2 --from-default-profile web --dump-config` 先只创建。）

## 4. 恢复备份

```powershell
# 列出 $DSH_HOME 下所有备份（按时间）
Get-ChildItem D:\dsh\home -Recurse -Filter '*.bak-*' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 20 FullName
# 启动器本身的备份（我 2026-09-27 加闸门/看护之前的那份）
Get-ChildItem D:\dsh -Filter 'start-dsh.cmd.bak-gate-*'
```

## 5. 把我加的启动链改动整体摘掉（回到"裸启动器"）

```powershell
Copy-Item (Get-ChildItem D:\dsh -Filter 'start-dsh.cmd.bak-gate-*' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName D:\dsh\start-dsh.cmd -Force
```

（也可以只删 `D:\dsh\config\start-gate.mjs` 或 `D:\dsh\config\host-supervisor.mjs`：启动器发现文件缺失会**警告后继续启动**，不会因为缺文件而拒绝起。）

## 6. 求援时带什么

把**整个最新事故目录**（`D:\dsh\state\incidents\<时间戳>-exit<N>\`）连同 `D:\dsh\dsh-console.log` 一起带走，
并在求助信息里写：`-GateOnly` 的输出、`summary.md` 的分类、你已经试过第 3 节里的哪几步。
**不要删任何东西**——被删掉的证据无法重建。
