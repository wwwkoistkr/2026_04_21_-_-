$ErrorActionPreference = "Stop"

if (Test-Path ".\.venv\Scripts\python.exe") {
  .\.venv\Scripts\python.exe main.py send
} else {
  python main.py send
}

