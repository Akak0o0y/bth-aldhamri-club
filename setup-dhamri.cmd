@echo off
setlocal
where winget >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 22+ from https://nodejs.org and FFmpeg full from https://www.gyan.dev/ffmpeg/builds/
  exit /b 1
)
echo Installing the official Node.js LTS and Gyan FFmpeg packages using Windows Package Manager.
winget install --id OpenJS.NodeJS.LTS --exact --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 echo Node installation returned a nonzero code. If already installed, continue.
winget install --id Gyan.FFmpeg --exact --source winget --accept-package-agreements --accept-source-agreements
if errorlevel 1 echo FFmpeg installation returned a nonzero code. Run dhamri doctor to check it.
echo Reopen CMD in this folder, then run: dhamri doctor
