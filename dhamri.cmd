@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required. Run setup-dhamri.cmd first, then reopen CMD.
  exit /b 1
)
node "%~dp0tools\dhamri\cli.mjs" %*
exit /b %errorlevel%
