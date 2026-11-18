@echo off
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0SuperAgent.ps1" %*
exit /b %ERRORLEVEL%
