@echo off
rem Nomad command, added by the Nomad installer. Runs the version named in ..\current.
setlocal
set "NOMAD_ROOT=%~dp0.."
set "NOMAD_V="
if exist "%NOMAD_ROOT%\current" set /p NOMAD_V=<"%NOMAD_ROOT%\current"
if not defined NOMAD_V goto missing
"%NOMAD_ROOT%\app\%NOMAD_V%\node.exe" "%NOMAD_ROOT%\app\%NOMAD_V%\node_modules\thenomad\dist\nomad.js" %* & exit /b
:missing
echo Nomad is not installed correctly: its version file is missing. Run the installer again from https://thenomad.website 1>&2
exit /b 1
