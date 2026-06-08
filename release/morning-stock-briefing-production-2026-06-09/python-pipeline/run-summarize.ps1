$ErrorActionPreference = "Stop"

if (Test-Path ".\.venv\Scripts\python.exe") {
  .\.venv\Scripts\python.exe main.py summarize
} else {
  python main.py summarize
}

