$ErrorActionPreference = "Stop"

if (Test-Path ".\.venv\Scripts\python.exe") {
  .\.venv\Scripts\python.exe main.py collect
} else {
  python main.py collect
}

