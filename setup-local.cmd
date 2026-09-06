@echo off
setlocal

set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL%" (
  echo [Echo Insight] Windows PowerShell was not found.
  exit /b 1
)

"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-local.ps1" %*
exit /b %errorlevel%
