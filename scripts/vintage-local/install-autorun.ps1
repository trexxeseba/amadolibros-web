# Instala el publicador Vintage desatendido en esta PC (Windows).
#
#   powershell -ExecutionPolicy Bypass -File scripts\vintage-local\install-autorun.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\vintage-local\install-autorun.ps1 -Uninstall
#
# Qué hace:
#   1. Evita que la PC se suspenda o hiberne conectada a la corriente.
#   2. Guarda el secreto de renovación (VINTAGE_RENEW_SECRET de Cloudflare Pages)
#      en la carpeta privada de estado, si todavía no está.
#   3. Crea stop.cmd y start.cmd en la carpeta de estado.
#   4. Registra la tarea programada "AmadoVintagePublisher": arranca al iniciar
#      sesión, se reinicia sola si se cae y no tiene límite de tiempo.
param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Python = "python",
  [string]$StateDir = (Join-Path $env:LOCALAPPDATA "Amado\VintagePublisher"),
  [int]$Target = 10000,
  [string]$NotifyUrl = "",
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$task = "AmadoVintagePublisher"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarea $task eliminada. La carpeta de estado $StateDir se conserva."
  exit 0
}

$private = Join-Path $StateDir "private"
New-Item -ItemType Directory -Force -Path $private | Out-Null
$secretFile = Join-Path $private "renew-secret.txt"
if (-not (Test-Path $secretFile) -or (Get-Content $secretFile -Raw).Trim().Length -lt 32) {
  $secret = Read-Host "Pegá VINTAGE_RENEW_SECRET (el mismo secreto cargado en Cloudflare Pages)"
  if ($secret.Trim().Length -lt 32) { throw "El secreto debe tener al menos 32 caracteres." }
  Set-Content -Path $secretFile -Value $secret.Trim() -NoNewline -Encoding ASCII
}

# 1. Sin suspensión ni hibernación con corriente.
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null

# 3. Botones de parada y arranque.
$script = Join-Path $Repo "scripts\vintage_autorun.py"
$extra = if ($NotifyUrl) { " --notify-url `"$NotifyUrl`"" } else { "" }
Set-Content -Path (Join-Path $StateDir "stop.cmd") -Encoding ASCII -Value @"
@echo off
echo manual %date% %time% > "$StateDir\STOP"
schtasks /End /TN "$task" >nul 2>&1
echo Publicador Vintage detenido. Para seguir, ejecuta start.cmd.
"@
Set-Content -Path (Join-Path $StateDir "start.cmd") -Encoding ASCII -Value @"
@echo off
del /q "$StateDir\STOP" 2>nul
schtasks /Run /TN "$task"
echo Publicador Vintage iniciado. Estado: "$StateDir\status.json". Registros: "$StateDir\logs".
"@

# 4. Tarea programada.
$action = New-ScheduledTaskAction -Execute $Python -Argument "`"$script`" --target $Target$extra" -WorkingDirectory $Repo
$triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME), (New-ScheduledTaskTrigger -AtStartup))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $task -Action $action -Trigger $triggers -Settings $settings -RunLevel Highest -Description "Publicador desatendido de Amado Vintage" | Out-Null
Remove-Item -Force (Join-Path $StateDir "STOP") -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $task

Write-Host "Listo. Tarea $task registrada y en marcha."
Write-Host "Estado:   $StateDir\status.json"
Write-Host "Registro: $StateDir\logs"
Write-Host "Parar:    $StateDir\stop.cmd   Seguir: $StateDir\start.cmd"
