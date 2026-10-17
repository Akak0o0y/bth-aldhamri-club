@echo off
setlocal
where go >nul 2>nul
if errorlevel 1 (
  echo Go 1.24 or newer is required to build. Download the prebuilt Windows release to run without Go.
  exit /b 1
)
pushd "%~dp0native"
go build -trimpath -ldflags="-s -w" -o "..\bin\dhamri-whip.exe" .
if errorlevel 1 goto finished
go build -trimpath -ldflags="-s -w" -o "..\bin\dhamri-input.exe" ./cmd/input
:finished
set "build_result=%errorlevel%"
popd
exit /b %build_result%
