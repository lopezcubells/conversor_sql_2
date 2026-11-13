@echo off
rem Consumo Historico conectado a la base LOCAL (solo esa pestana).
rem Abre http://localhost:PUERTO. Para detenerlo, cerrar esta ventana.
cd /d "%~dp0"
title Consumo Historico - local

where node >nul 2>nul
if errorlevel 1 goto sin_node
if not exist ".env" goto sin_env

rem Usa las dependencias de la app (carpeta de arriba)
if exist "..\node_modules\pg" goto arrancar
echo Instalando dependencias, solo la primera vez...
pushd ..
call npm install
popd
if errorlevel 1 goto error

:arrancar
set "PUERTO=3001"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" ".env"') do if not "%%b"=="" set "PUERTO=%%b"
echo.
echo   Consumo Historico local en http://localhost:%PUERTO%
echo   Para detenerlo, cerrar esta ventana.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:%PUERTO%"
node servidor.js
goto fin

:sin_node
echo No se encontro Node.js. Instalarlo desde https://nodejs.org - version LTS - y volver a ejecutar.
goto fin

:sin_env
echo Falta el archivo .env en esta carpeta. Copiar .env.example como .env y completar DATABASE_URL.
goto fin

:error
echo No se pudieron instalar las dependencias.

:fin
pause
