@echo off
setlocal
cd /d "%~dp0python-pipeline"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\run-send.ps1"
pause

