# Launcher integration / 启动器接线

Add the gate before the host starts and the supervisor after it exits. These are the lines used in a `start-dsh.cmd` (LF line endings, no BOM).
在宿主启动前加闸门、在它退出后加看护。下面是 `start-dsh.cmd` 里实际使用的行（LF 行尾、无 BOM）。

```bat
set "DSH_GATE=%~dp0config\start-gate.mjs"
set "DSH_NODE=<path to node.exe>"
set "DSH_GATE_ONLY="
if /i "%~1"=="-GateOnly" set "DSH_GATE_ONLY=1"

if defined DSH_SKIP_GATE (
  echo [dsh] startup gate skipped ^(DSH_SKIP_GATE is set^)
  if defined DSH_GATE_ONLY ( endlocal & exit /b 0 )
  goto :launch
)

if not exist "%DSH_GATE%" (
  echo [dsh] warning: startup gate not found at "%DSH_GATE%" - launching without it
  if defined DSH_GATE_ONLY ( endlocal & exit /b 0 )
  goto :launch
)

"%DSH_NODE%" "%DSH_GATE%"
if errorlevel 1 goto :gate_refused

if defined DSH_GATE_ONLY (
  echo [dsh] startup gate passed; -GateOnly given, so the host was not started.
  endlocal & exit /b 0
)
goto :launch

:gate_refused
echo.
echo [dsh] startup gate REFUSED to launch. Fix the item reported above, or bypass once with:
echo         set DSH_SKIP_GATE=1
endlocal & exit /b 1

:launch
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-dsh.ps1"
set "CODE=%ERRORLEVEL%"
REM  Test the captured variable, not `if errorlevel`: a successful `set` resets ERRORLEVEL to 0. / 判断已捕获的变量，不要用 if errorlevel：set 会把 ERRORLEVEL 归零。
if not "%CODE%"=="0" if not "%CODE%"=="" if exist "%~dp0config\host-supervisor.mjs" "%DSH_NODE%" "%~dp0config\host-supervisor.mjs" --exit-code %CODE% --repair
endlocal & exit /b %CODE%
```

The supervisor is what starts the repair ladder, and only when `DSH_SUPERVISOR_REPAIR_AGENT=1` is set; without it the supervisor collects evidence and applies at most the `pnpm install` re-sync.
修复阶梯由看护拉起，且仅在 `DSH_SUPERVISOR_REPAIR_AGENT=1` 时；否则看护只收集证据，至多做一次 `pnpm install` 重同步。
