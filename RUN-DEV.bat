@echo off
REM Runs Channel Blend Softphone straight from source (no installer) for quick testing.
cd /d "%~dp0"
if not exist node_modules call npm install
call npm start
