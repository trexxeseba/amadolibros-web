@echo off
rem Motor de precios Amado Libros: una corrida. La llama el Programador de tareas.
rem Los secretos viven FUERA del repo, en %LOCALAPPDATA%\AmadoPrecios\secretos.cmd:
rem   set PRICING_TOKEN_SECRET=...      (o, para la simulación, set ML_ACCESS_TOKEN=...)
rem   set ALERTA_SMTP_USER=cuenta@gmail.com
rem   set ALERTA_SMTP_PASS=contraseña-de-aplicacion
rem   set ALERTA_DESTINO=el mail de Seba
setlocal
set "SECRETOS=%LOCALAPPDATA%\AmadoPrecios\secretos.cmd"
if exist "%SECRETOS%" call "%SECRETOS%"
cd /d "%~dp0..\.."
set "FRANJA=%~1"
rem Simulación hasta el GO de Seba: para escribir hay que agregar --real Y poner datos\modo.json en "real".
node --no-warnings --experimental-sqlite precios-libros-local\src\run.mjs --franja "%FRANJA%" >> "precios-libros-local\datos\corridas.log" 2>&1
exit /b %ERRORLEVEL%
