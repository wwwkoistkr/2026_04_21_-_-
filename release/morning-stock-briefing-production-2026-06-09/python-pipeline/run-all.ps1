$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $scriptDir

if (Test-Path ".\.venv\Scripts\python.exe") {
  .\.venv\Scripts\python.exe main.py all
} else {
  python main.py all
}
