@echo off
rem Opens the Nomad dashboard. Used by the Nomad shortcut in the Start menu.
title Nomad
call "%~dp0nomad.cmd" ui --app
if errorlevel 1 pause
