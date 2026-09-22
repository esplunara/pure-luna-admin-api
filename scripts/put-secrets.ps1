# Upload secrets from .dev.vars to Cloudflare Worker
$ErrorActionPreference = "Stop"

$varsFile = Join-Path $PSScriptRoot ".." ".dev.vars"
if (-not (Test-Path $varsFile)) {
    Write-Error ".dev.vars not found. Copy .dev.vars.example to .dev.vars first."
}

$secrets = @(
    "PURE_LUNA_BUILD_TOKEN",
    "GOOGLE_SHEETS_ID",
    "GOOGLE_CLIENT_EMAIL",
    "GOOGLE_PRIVATE_KEY"
)

foreach ($name in $secrets) {
    $line = Get-Content $varsFile | Where-Object { $_ -match "^$name=" } | Select-Object -First 1
    if (-not $line) {
        Write-Error "Missing $name in .dev.vars"
    }
    $value = $line -replace "^$name=", ""
    Write-Host "Setting secret: $name"
    $value | npx wrangler secret put $name
}

Write-Host "Done."
