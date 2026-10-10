@echo off
if "%~1"=="" (
  "%~dp0node\node.exe" "%~dp0src\cli.js" open
) else (
  "%~dp0node\node.exe" "%~dp0src\cli.js" %*
)
exit /b %errorlevel%
