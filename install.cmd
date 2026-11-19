@echo off
setlocal
cd /d "%~dp0"
echo.
echo Love2D Studio installer
echo -----------------------
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org/
  exit /b 1
)
echo Installing Node dependencies...
call npm install --no-audit --no-fund
if errorlevel 1 exit /b 1
echo.
call node bin\love2d-studio.js setup --install-zed --install-luacats
if errorlevel 1 exit /b 1
echo.
echo Setup complete. Start the desktop Studio with:
echo   Love2D Studio.cmd
echo or double-click dist\Love2D Studio-win32-x64\Love2D Studio.exe after npm run package.
echo.
echo Or create a project in Zed once a project has been opened in the Studio.
pause
