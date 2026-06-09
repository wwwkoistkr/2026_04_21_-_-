@echo off
setlocal
cd /d "%~dp0python-pipeline"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\run-all.ps1"
pause

