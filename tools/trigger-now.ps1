param(
  [string]$BaseUrl = "https://morning-stock-briefing.pages.dev",
  [ValidateSet("collect", "summarize", "send", "all")]
  [string]$Stage = "all",
  [switch]$DryRun,
  [string]$Password
)

$ErrorActionPreference = "Stop"

function Write-Step($Message) {
  Write-Host "[trigger-now] $Message" -ForegroundColor Cyan
}

function Normalize-BaseUrl($Url) {
  $raw = ""
  if ($null -ne $Url) {
    $raw = [string]$Url
  }
  $trimmed = $raw.Trim().TrimEnd("/")
  if (-not $trimmed) {
    throw "BaseUrl is empty."
  }
  if ($trimmed -notmatch "^https?://") {
    $trimmed = "https://$trimmed"
  }
  return $trimmed
}

$BaseUrl = Normalize-BaseUrl $BaseUrl

if (-not $Password) {
  $secure = Read-Host "ADMIN_PASSWORD" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $Password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  } finally {
    if ($ptr -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
  }
}

if (-not $Password) {
  throw "ADMIN_PASSWORD is required."
}

$loginUrl = "$BaseUrl/login"
$triggerUrl = "$BaseUrl/api/admin/trigger-now"

Write-Step "Logging in to $loginUrl"
$loginBody = @{ password = $Password }
Invoke-WebRequest `
  -Uri $loginUrl `
  -Method Post `
  -Body $loginBody `
  -ContentType "application/x-www-form-urlencoded" `
  -SessionVariable session `
  -MaximumRedirection 5 | Out-Null

$sessionCookie = $session.Cookies.GetCookies([Uri]$BaseUrl)["msaic_session"]
if (-not $sessionCookie) {
  throw "Login failed. Check ADMIN_PASSWORD / Cloudflare ADMIN_PASSWORD secret."
}

Write-Step "Calling $triggerUrl (stage=$Stage, dryRun=$($DryRun.IsPresent))"
$payload = @{
  stage = $Stage
  dryRun = [bool]$DryRun
} | ConvertTo-Json -Compress

$response = Invoke-RestMethod `
  -Uri $triggerUrl `
  -Method Post `
  -WebSession $session `
  -ContentType "application/json" `
  -Body $payload

$response | ConvertTo-Json -Depth 8

if ($response.ok) {
  Write-Host "GitHub Actions trigger request succeeded." -ForegroundColor Green
  if ($response.runsUrl) {
    Write-Host "Runs URL: $($response.runsUrl)" -ForegroundColor Green
  }
} else {
  Write-Host "GitHub Actions trigger request failed." -ForegroundColor Red
  exit 1
}
