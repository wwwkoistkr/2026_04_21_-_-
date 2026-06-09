@echo off
setlocal
cd /d "%~dp0python-pipeline"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\setup-python.ps1"
pause

