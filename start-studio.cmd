@echo off
setlocal
cd /d "%~dp0"
if exist "dist\Love2D Studio-win32-x64\Love2D Studio.exe" (
  start "" "dist\Love2D Studio-win32-x64\Love2D Studio.exe" %*
) else (
  call npm run desktop -- %*
)
