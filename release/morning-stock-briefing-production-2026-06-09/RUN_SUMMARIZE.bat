@echo off
setlocal
cd /d "%~dp0python-pipeline"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\run-summarize.ps1"
pause

