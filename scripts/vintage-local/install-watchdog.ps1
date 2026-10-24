# Instala el vigía local del publicador Vintage en esta PC (Windows).
#
#   powershell -ExecutionPolicy Bypass -File scripts\vintage-local\install-watchdog.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\vintage-local\install-watchdog.ps1 -Uninstall
#
# Registra la tarea "AmadoVintageWatchdog": cada 10 minutos corre
# scripts\vintage-local\watchdog.py sin abrir ventana. Si el publicador murió
# (ventana cerrada, Ctrl+C, error fatal) lo relanza; si no hay altas nuevas sin
# una espera que lo explique, avisa por ntfy. Respeta el archivo STOP.
# No necesita elevación: corre como el usuario actual, igual que el publicador.
param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [string]$Python = "python",
  [string]$StateDir = (Join-Path $env:LOCALAPPDATA "Amado\VintagePublisher"),
  [string]$NotifyUrl = "",
  [int]$EveryMinutes = 10,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$task = "AmadoVintageWatchdog"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Tarea $task eliminada."
  exit 0
}

# Mismo Python real que usa el publicador (el alias de la Microsoft Store no sirve en tareas).
$pythonCmd = Get-Command $Python -ErrorAction SilentlyContinue
if (-not $pythonCmd) { $pythonCmd = Get-Command py -ErrorAction SilentlyContinue }
if (-not $pythonCmd) { throw "No se encontró Python." }
$PythonExe = (& $pythonCmd.Source -c "import sys; print(sys.executable)" 2>$null | Select-Object -Last 1)
if (-not $PythonExe -or -not (Test-Path $PythonExe)) { $PythonExe = $pythonCmd.Source }
# pythonw.exe no abre consola; si no está, python.exe con la ventana oculta.
$pythonw = Join-Path (Split-Path $PythonExe) "pythonw.exe"
$exe = if (Test-Path $pythonw) { $pythonw } else { $PythonExe }

# Si no se indicó URL de avisos, usar la misma que el publicador (run.cmd).
if (-not $NotifyUrl) {
  $runCmd = Join-Path $StateDir "run.cmd"
  if (Test-Path $runCmd) {
    $m = [regex]::Match((Get-Content $runCmd -Raw), '--notify-url\s+"([^"]+)"')
    if ($m.Success) { $NotifyUrl = $m.Groups[1].Value }
  }
}
$script = Join-Path $Repo "scripts\vintage-local\watchdog.py"
if (-not (Test-Path $script)) { throw "No existe $script" }
$arguments = "`"$script`" --directory `"$StateDir`""
if ($NotifyUrl) { $arguments += " --notify-url `"$NotifyUrl`"" }

$action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -Hidden
Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -RunLevel Limited -Description "Vigía del publicador de Amado Vintage: relanza si se cae y avisa si no publica" | Out-Null

Write-Host "Listo. Tarea $task registrada: cada $EveryMinutes minutos, sin ventana."
Write-Host "Python:   $exe"
Write-Host "Avisos:   $(if ($NotifyUrl) { $NotifyUrl } else { '(sin URL: sólo relanza y registra)' })"
Write-Host "Registro: $StateDir\logs\watchdog-*.log"
Write-Host "Probar:   `"$PythonExe`" `"$script`" --directory `"$StateDir`" --dry-run"
