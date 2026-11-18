@echo off
REM Builds the Windows installer into the "dist" folder.
REM Needs Node.js 20 or newer (https://nodejs.org) installed once.
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Get it from https://nodejs.org & pause & exit /b 1)
echo Installing build tools (first time takes a few minutes)...
call npm install || (pause & exit /b 1)
if not exist "src\main\config\provisioning.key" (
  echo.
  echo No company key yet - creating one. Copy the value shown into your GitHub secret.
  call node scripts\make-key.js
  echo.
  pause
)
echo Running engine self-test...
call npm test || (pause & exit /b 1)
echo Building installer...
call npm run dist:win || (pause & exit /b 1)
echo.
echo Done! Your installer is in the "dist" folder.
start "" "%~dp0dist"
pause
