@echo off
setlocal
cd /d "%~dp0"
call node bin\love2d-studio.js studio %*
