@echo off
setlocal
cd /d "%~dp0"
set GIT_TERMINAL_PROMPT=1
set GCM_INTERACTIVE=always
echo Uploading committed Tradesuite code to GitHub.
echo If GitHub asks you to sign in, use your samgoldstein03-art account.
echo.
git push origin HEAD:main
if errorlevel 1 (
  echo.
  echo GitHub was not updated. Keep this window open to read the error.
  pause
  exit /b 1
)
echo.
echo GitHub is up to date with the committed code.
echo https://github.com/samgoldstein03-art/trades-suite
pause
