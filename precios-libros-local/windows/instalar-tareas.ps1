# Crea las tres tareas del motor de precios en el Programador de tareas de Windows.
# Correr una vez, en PowerShell, desde la carpeta del repo:
#   powershell -ExecutionPolicy Bypass -File precios-libros-local\windows\instalar-tareas.ps1
# Horarios en hora de la PC (debe estar en hora de Montevideo).
param([string[]]$Horarios = @('09:30', '14:30', '20:30'))

$cmd = Join-Path $PSScriptRoot 'correr.cmd'
New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot '..\datos') | Out-Null

# Comportamiento definido:
#  - StartWhenAvailable: si la PC estaba apagada o suspendida a la hora, corre UNA vez al
#    volver (Windows no acumula las perdidas). El motor registra las franjas omitidas y avisa.
#  - MultipleInstances IgnoreNew + lock propio: nunca dos corridas a la vez.
#  - No despierta la PC (WakeToRun apagado): si está suspendida, se omite y queda registrado.
#  - Límite de 2 horas por corrida; el lock vence a las 2 horas.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

foreach ($h in $Horarios) {
  $nombre = "AmadoPrecios $($h.Replace(':',''))"
  $accion = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$cmd`" $h"
  $trigger = New-ScheduledTaskTrigger -Daily -At $h
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
  Write-Host "Tarea creada: $nombre"
}
Write-Host 'Listo. Para borrarlas: Unregister-ScheduledTask -TaskName "AmadoPrecios*" -Confirm:$false'
