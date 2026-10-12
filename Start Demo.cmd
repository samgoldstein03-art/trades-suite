@echo off
setlocal
title Tradesuite - Demo
cd /d "%~dp0"
echo.
echo   TRADESUITE DEMO
echo   This demo never sends real texts.
echo.
where node >nul 2>nul
if errorlevel 1 goto missing_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 goto missing_node
if not exist "node_modules\express\package.json" (
  echo Installing the app. This can take a minute...
  call npm ci
  if errorlevel 1 goto install_failed
)
set PORT=3000
echo Keep this window open while using the dashboard.
echo Close this window to stop the demo.
echo.
node scripts/demo.js --open
if errorlevel 1 (
  echo.
  echo The demo stopped. Please copy the message above if you need help.
  pause
)
exit /b

:missing_node
echo Node.js 24 or newer is needed to run this app.
echo Install it from https://nodejs.org/en/download and open this file again.
pause
exit /b 1

:install_failed
echo.
echo Installation did not finish. Check your connection and the message above.
echo No real texts have been sent.
pause
exit /b 1
