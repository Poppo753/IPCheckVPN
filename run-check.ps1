<# 
  run-check.ps1
  Esegue il check di rete e pusha su GitHub.
  Da usare con Operazioni Pianificate di Windows (ogni 1-5 min).
#>

$ErrorActionPreference = "Continue"

# Vai nella cartella del progetto
Set-Location $PSScriptRoot

# Esegui il check (scrive public/status.json)
node dist/check.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "Check fallito, skip push"
    exit 1
}

# Commit + push
node dist/push.js
