@echo off
rem Lanzador del publicador Vintage para la tarea programada (lo llama run.cmd).
rem Vive en el repo para que git pull también lo actualice.
rem   launch.cmd <python.exe> <carpeta de estado> <target> [--notify-url URL]
rem Reinicia el supervisor si se cae o si salió para recargar código nuevo (código 75);
rem sólo termina con el archivo STOP o con un STOP escrito por el propio supervisor.
setlocal
set "PY=%~1"
set "STATE=%~2"
set "TARGET=%~3"
set "NOTIFY=%~4 %~5"
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
set GIT_TERMINAL_PROMPT=0
cd /d "%~dp0..\.."
:loop
if exist "%STATE%\STOP" goto end
rem El Python de la Microsoft Store cambia de carpeta al actualizarse: si la ruta guardada
rem ya no existe, se usa el que esté en el PATH.
if not exist "%PY%" set "PY=python"
echo [%date% %time%] inicio >> "%STATE%\logs\task.log"
"%PY%" scripts\vintage_autorun.py --target %TARGET% --directory "%STATE%" %NOTIFY% >> "%STATE%\logs\task.log" 2>&1
echo [%date% %time%] fin codigo %errorlevel% >> "%STATE%\logs\task.log"
rem task.log sólo guarda arranques y caídas; si crece de más se recorta.
for %%F in ("%STATE%\logs\task.log") do if %%~zF GTR 5000000 move /y "%STATE%\logs\task.log" "%STATE%\logs\task.old.log" >nul
if exist "%STATE%\STOP" goto end
timeout /t 60 /nobreak >nul
goto loop
:end
echo [%date% %time%] detenido por STOP >> "%STATE%\logs\task.log"
endlocal
