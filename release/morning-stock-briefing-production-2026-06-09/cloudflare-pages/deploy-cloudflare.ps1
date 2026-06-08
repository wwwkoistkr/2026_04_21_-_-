$ErrorActionPreference = "Stop"

Write-Host "Deploying Morning Stock Briefing web console to Cloudflare Pages..." -ForegroundColor Cyan

if (-not (Test-Path ".\dist\_worker.js")) {
  throw "dist/_worker.js was not found. This release package is incomplete."
}

npx wrangler pages deploy .\dist --project-name morning-stock-briefing

Write-Host "Cloudflare Pages deploy command completed." -ForegroundColor Green

