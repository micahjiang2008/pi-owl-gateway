@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
set "GATEWAY_DIR=%SCRIPT_DIR%.."
node "%GATEWAY_DIR%\bin\gateway.mjs" %*
