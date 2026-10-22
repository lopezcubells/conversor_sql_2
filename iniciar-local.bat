@echo off
rem Arranca la app en esta PC y abre el navegador en http://localhost:PUERTO
rem Para detenerla, cerrar esta ventana.
cd /d "%~dp0"
title Reporte de Indicadores - Insumos (local)

where node >nul 2>nul
if errorlevel 1 goto sin_node
if not exist ".env" goto sin_env

if exist "node_modules" goto arrancar
echo Instalando dependencias, solo la primera vez...
call npm install
if errorlevel 1 goto error

:arrancar
set "PUERTO=3000"
for /f "tokens=1,* delims==" %%a in ('findstr /b /c:"PORT=" ".env"') do if not "%%b"=="" set "PUERTO=%%b"
echo.
echo   App local en http://localhost:%PUERTO%
echo   Para detenerla, cerrar esta ventana.
echo.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:%PUERTO%"
call npm start
goto fin

:sin_node
echo No se encontro Node.js. Instalarlo desde https://nodejs.org - version LTS - y volver a ejecutar.
goto fin

:sin_env
echo Falta el archivo .env. Copiar .env.example como .env y completar los datos.
goto fin

:error
echo No se pudieron instalar las dependencias. Revisar la conexion a internet.

:fin
pause
