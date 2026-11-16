@echo off
rem Opens the Nomad dashboard. Used by the Nomad shortcut in the Start menu.
setlocal
set "NOMAD_ROOT=%~dp0.."
set "NOMAD_V="
if exist "%NOMAD_ROOT%\current" set /p NOMAD_V=<"%NOMAD_ROOT%\current"
if not defined NOMAD_V goto missing
rem See nomad.cmd: nothing here is read again after Nomad exits, even if an update replaced this file.
endlocal & goto #_undefined_# 2>NUL || title Nomad & "%NOMAD_ROOT%\app\%NOMAD_V%\node.exe" "%NOMAD_ROOT%\app\%NOMAD_V%\node_modules\thenomad\dist\nomad.js" ui --app || pause
:missing
title Nomad
echo Nomad is not installed correctly: its version file is missing. Run the installer again from https://thenomad.website
pause
exit /b 1
