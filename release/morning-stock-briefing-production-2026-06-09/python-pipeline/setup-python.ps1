$ErrorActionPreference = "Stop"

Write-Host "Setting up Python virtual environment..." -ForegroundColor Cyan

if (-not (Test-Path ".\.venv")) {
  python -m venv .venv
}

.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\pip.exe install -r requirements.txt

Write-Host "Python pipeline setup completed." -ForegroundColor Green

