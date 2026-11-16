@echo off
rem Nomad command, added by the Nomad installer. Runs the version named in ..\current.
setlocal
set "NOMAD_ROOT=%~dp0.."
set "NOMAD_V="
if exist "%NOMAD_ROOT%\current" set /p NOMAD_V=<"%NOMAD_ROOT%\current"
if not defined NOMAD_V goto missing
rem The same line npm uses for its commands: the failed goto ends this file, the rest of the line
rem still runs, so Nomad's exit code is the result and nothing here is read again after it exits.
endlocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%NOMAD_ROOT%\app\%NOMAD_V%\node.exe" "%NOMAD_ROOT%\app\%NOMAD_V%\node_modules\thenomad\dist\nomad.js" %*
:missing
echo Nomad is not installed correctly: its version file is missing. Run the installer again from https://thenomad.website 1>&2
exit /b 1
