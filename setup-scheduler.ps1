<#
  setup-scheduler.ps1
  Crea un'operazione pianificata di Windows che esegue run-check.ps1 ogni 5 minuti.
  ⚠ Eseguire come Amministratore!
#>

$taskName   = "HomeStatusCheck"
$scriptPath = Join-Path $PSScriptRoot "run-check.ps1"
$nodeCheck  = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCheck) {
    Write-Error "Node.js non trovato nel PATH. Installalo prima: https://nodejs.org"
    exit 1
}

# Rimuovi task esistente se presente
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Task precedente '$taskName' rimosso."
}

# Azione: esegui PowerShell con lo script
$action = New-ScheduledTaskAction `
    -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`"" `
    -WorkingDirectory $PSScriptRoot

# Trigger: ogni 5 minuti, indefinitamente
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration ([TimeSpan]::MaxValue)

# Impostazioni
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RunOnlyIfNetworkAvailable

# Registra con l'utente corrente
Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description "Controlla stato rete di casa e aggiorna GitHub Pages" `
    -RunLevel Highest

Write-Host ""
Write-Host "✅ Task '$taskName' creato! Gira ogni 5 minuti."
Write-Host "   Per cambiare intervallo: apri Utilità di pianificazione > '$taskName' > Trigger"
Write-Host "   Per disabilitare:  Disable-ScheduledTask -TaskName '$taskName'"
Write-Host "   Per rimuovere:     Unregister-ScheduledTask -TaskName '$taskName'"
