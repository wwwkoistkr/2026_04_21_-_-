$ErrorActionPreference = "Stop"

if (Test-Path ".\.venv\Scripts\python.exe") {
  .\.venv\Scripts\python.exe main.py all
} else {
  python main.py all
}

