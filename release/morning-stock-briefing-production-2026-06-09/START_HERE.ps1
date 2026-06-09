$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pipeline = Join-Path $root "python-pipeline"

Write-Host ""
Write-Host "Morning Stock Briefing Production Release" -ForegroundColor Cyan
Write-Host "Release folder: $root"
Write-Host ""
Write-Host "Available commands:" -ForegroundColor Yellow
Write-Host "  1. Setup Python once : .\RUN_SETUP.bat"
Write-Host "  2. Collect news       : .\RUN_COLLECT.bat"
Write-Host "  3. Summarize news     : .\RUN_SUMMARIZE.bat"
Write-Host "  4. Send email         : .\RUN_SEND.bat"
Write-Host "  5. Run all stages     : .\RUN_ALL.bat"
Write-Host ""
Write-Host "PowerShell path tip:" -ForegroundColor Yellow
Write-Host '  If you type cd manually, wrap this path in quotes because it contains Korean text and parentheses.'
Write-Host "  cd `"$pipeline`""
Write-Host ""

Set-Location -LiteralPath $pipeline
Write-Host "Moved to python-pipeline:" -ForegroundColor Green
Get-Location

