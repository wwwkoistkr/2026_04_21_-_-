param(
  [string]$BaseUrl = "https://morning-stock-briefing.pages.dev"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $scriptDir
$BaseUrl = $BaseUrl.Trim().TrimEnd("/")
if ($BaseUrl -notmatch "^https?://") {
  $BaseUrl = "https://$BaseUrl"
}

function Show-Title {
  Clear-Host
  Write-Host "==============================================" -ForegroundColor Cyan
  Write-Host " Morning Stock AI - Launcher" -ForegroundColor Cyan
  Write-Host "==============================================" -ForegroundColor Cyan
  Write-Host ""
  Write-Host "Production app URL:" -ForegroundColor Yellow
  Write-Host "  $BaseUrl/login"
  Write-Host ""
  Write-Host "Daily automation is run by GitHub Actions."
  Write-Host "This launcher opens the admin app or requests GitHub Actions runs."
  Write-Host ""
}

function Wait-Enter {
  Write-Host ""
  Read-Host "Press Enter to continue"
}

function Open-Admin {
  Write-Host "Opening admin app: $BaseUrl/login" -ForegroundColor Green
  Start-Process "$BaseUrl/login"
}

function Invoke-Stage($Stage, [switch]$DryRun) {
  $triggerScript = Join-Path $repoRoot "tools\trigger-now.ps1"
  if (-not (Test-Path $triggerScript)) {
    throw "trigger script not found: $triggerScript"
  }
  if ($DryRun) {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $triggerScript -BaseUrl $BaseUrl -Stage $Stage -DryRun
  } else {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $triggerScript -BaseUrl $BaseUrl -Stage $Stage
  }
}

function Deploy-Cloudflare {
  Set-Location -LiteralPath $repoRoot
  Write-Host "Deploying web app to Cloudflare Pages..." -ForegroundColor Yellow
  Write-Host "Requirements: Cloudflare login, project permission, npm dependencies."
  Write-Host ""
  npm run build
  npx wrangler pages deploy dist --project-name morning-stock-briefing
}

while ($true) {
  Show-Title
  Write-Host "Choose an action:" -ForegroundColor White
  Write-Host ""
  Write-Host "  1. Open admin web app"
  Write-Host "  2. Run collect stage      (GitHub Actions)"
  Write-Host "  3. Run summarize stage    (GitHub Actions)"
  Write-Host "  4. Run send DRY RUN       (no real email)"
  Write-Host "  5. Run send REAL          (real email)"
  Write-Host "  6. Run all workflow       (legacy all)"
  Write-Host "  7. Deploy to Cloudflare"
  Write-Host "  8. What is this app?"
  Write-Host "  0. Exit"
  Write-Host ""
  $choice = Read-Host "Enter number"

  try {
    switch ($choice) {
      "1" { Open-Admin; Wait-Enter }
      "2" { Invoke-Stage "collect"; Wait-Enter }
      "3" { Invoke-Stage "summarize"; Wait-Enter }
      "4" { Invoke-Stage "send" -DryRun; Wait-Enter }
      "5" { Invoke-Stage "send"; Wait-Enter }
      "6" { Invoke-Stage "all"; Wait-Enter }
      "7" { Deploy-Cloudflare; Wait-Enter }
      "8" {
        Write-Host ""
        Write-Host "The real app is this web URL:" -ForegroundColor Green
        Write-Host "  $BaseUrl/login"
        Write-Host ""
        Write-Host "GitHub Actions runs the daily jobs:"
        Write-Host "  daily_01_collect.yml    collect"
        Write-Host "  daily_02_summarize.yml  summarize"
        Write-Host "  daily_03_send.yml       send"
        Write-Host ""
        Write-Host "This launcher is a beginner helper."
        Write-Host "It can open the web app, call the admin API, or deploy to Cloudflare."
        Write-Host ""
        Write-Host "Cloudflare deploy requires Cloudflare account login and permission."
        Wait-Enter
      }
      "0" { break }
      default {
        Write-Host "Invalid number." -ForegroundColor Red
        Wait-Enter
      }
    }
  } catch {
    Write-Host ""
    Write-Host "Error:" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    Wait-Enter
  }
}
