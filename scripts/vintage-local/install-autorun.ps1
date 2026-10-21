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
#      sesión, se reinicia sola si se cae y no tiene límite de tiempo. Corre sin
#      elevación: un proceso elevado no puede abrir el Python de la Microsoft Store.
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

# 0. Rutas completas: el Programador de tareas no usa el PATH de la consola ni los
#    alias de la Microsoft Store, así que la tarea tiene que apuntar al ejecutable real.
$pythonCmd = Get-Command $Python -ErrorAction SilentlyContinue
if (-not $pythonCmd) { $pythonCmd = Get-Command py -ErrorAction SilentlyContinue }
if (-not $pythonCmd) { throw "No se encontró Python. Instalalo desde https://www.python.org/downloads/windows/ (marcá 'Add python.exe to PATH') y volvé a correr este instalador." }
# Con el Python de la Microsoft Store, python.exe es un alias de WindowsApps que el
# Programador de tareas no puede abrir (0x80070002); sys.executable da el binario real.
$PythonExe = (& $pythonCmd.Source -c "import sys; print(sys.executable)" 2>$null | Select-Object -Last 1)
if (-not $PythonExe -or -not (Test-Path $PythonExe)) { $PythonExe = $pythonCmd.Source }
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw "No se encontró Node.js. Instalá Node 22 LTS desde https://nodejs.org y volvé a correr este instalador." }
$nodeVersion = [version]((& $nodeCmd.Source --version).TrimStart("v"))
if ($nodeVersion -lt [version]"22.13.0") { throw "Node $nodeVersion es viejo; hace falta 22.13 o posterior." }
$pyOk = & $PythonExe -c "import sys; print(sys.version_info >= (3, 9))" 2>$null
if ("$pyOk".Trim() -ne "True") { throw "Python en $PythonExe no responde o es anterior a 3.9." }
Write-Host "Python: $PythonExe"
Write-Host "Node:   $($nodeCmd.Source) ($nodeVersion)"

$private = Join-Path $StateDir "private"
New-Item -ItemType Directory -Force -Path $private | Out-Null
$secretFile = Join-Path $private "renew-secret.txt"
if (-not (Test-Path $secretFile) -or (Get-Content $secretFile -Raw).Trim().Length -lt 32) {
  $secret = Read-Host "Pegá VINTAGE_RENEW_SECRET (el mismo secreto cargado en Cloudflare Pages)"
  if ($secret.Trim().Length -lt 32) { throw "El secreto debe tener al menos 32 caracteres." }
  Set-Content -Path $secretFile -Value $secret.Trim() -NoNewline -Encoding ASCII
}
# Usuario del portal de SBS (ag.sbs.com.ar), de donde se baja "Lista completa de disponibles".
$sbsFile = Join-Path $private "sbs.json"
if (-not (Test-Path $sbsFile)) {
  $sbsEmail = Read-Host "Correo del usuario de SBS (ag.sbs.com.ar), vacío para usar el Excel público"
  if ($sbsEmail.Trim()) {
    $sbsPassword = Read-Host "Contraseña de SBS"
    @{ email = $sbsEmail.Trim(); password = $sbsPassword } | ConvertTo-Json -Compress | Set-Content -Path $sbsFile -NoNewline -Encoding UTF8
  }
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
# run.cmd deja en logs\task.log cualquier error previo al propio registro de Python
# (intérprete ausente, SyntaxError, módulo faltante), que de otro modo sería invisible.
$logs = Join-Path $StateDir "logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null
Set-Content -Path (Join-Path $StateDir "run.cmd") -Encoding ASCII -Value @"
@echo off
cd /d "$Repo"
echo [%date% %time%] inicio >> "$logs\task.log"
"$PythonExe" "$script" --target $Target --node "$($nodeCmd.Source)"$extra >> "$logs\task.log" 2>&1
echo [%date% %time%] fin codigo %errorlevel% >> "$logs\task.log"
"@
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"`"$StateDir\run.cmd`"`"" -WorkingDirectory $Repo
$triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME), (New-ScheduledTaskTrigger -AtStartup))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $task -Action $action -Trigger $triggers -Settings $settings -RunLevel Limited -Description "Publicador desatendido de Amado Vintage" | Out-Null
Remove-Item -Force (Join-Path $StateDir "STOP") -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $task

Write-Host "Listo. Tarea $task registrada y en marcha."
Write-Host "Estado:   $StateDir\status.json"
Write-Host "Registro: $StateDir\logs  (task.log si no arranca; autorun-*.log en marcha)"
Write-Host "Parar:    $StateDir\stop.cmd   Seguir: $StateDir\start.cmd"
