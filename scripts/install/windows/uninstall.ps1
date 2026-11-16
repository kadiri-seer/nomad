# Removes Nomad installed from thenomad.website. Your agents are not touched.
# Runs from Settings > Apps > Nomad > Uninstall, or through: nomad uninstall
param(
  [switch]$Yes,
  [switch]$RemoveData,
  [int]$WaitPid = 0,
  [string]$DataDir = ''
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$interactive = -not $Yes

function Finish([int]$code) {
  if ($interactive) { [void](Read-Host 'Press Enter to close') }
  exit $code
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'install.json'))) {
  Write-Host "This folder does not look like a Nomad install: $root"
  Finish 1
}
if (-not $DataDir) { $DataDir = if ($env:NOMAD_HOME) { $env:NOMAD_HOME } else { Join-Path $HOME '.nomad' } }

if ($interactive) {
  Write-Host "This removes Nomad from $root, with its Start menu shortcut and the nomad command."
  Write-Host 'Your agents are not touched.'
  $answer = Read-Host 'Remove Nomad? [y/N]'
  if ($answer -notmatch '^(y|yes)$') { Write-Host 'Nothing was removed.'; Finish 0 }
  if (-not $RemoveData -and (Test-Path -LiteralPath $DataDir)) {
    $answer = Read-Host "Also delete the library, backups and history in ${DataDir}? Backups cannot be restored after this. [y/N]"
    $RemoveData = $answer -match '^(y|yes)$'
  }
}

# Windows cannot delete a running program: wait for the nomad command that started this to finish.
if ($WaitPid -gt 0) {
  Wait-Process -Id $WaitPid -Timeout 60 -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}
Set-Location -LiteralPath $env:TEMP

# Start menu shortcut
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nomad.lnk'
if (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut -Force }

# Settings > Apps entry
$appsKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nomad'
if (Test-Path -LiteralPath $appsKey) { Remove-Item -LiteralPath $appsKey -Recurse -Force }

# The nomad command: take Nomad's folder out of your PATH, keeping every other entry as it was.
$bin = (Join-Path $root 'bin').TrimEnd('\')
$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
if ($envKey) {
  $path = [string]$envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $entries = @($path -split ';' | Where-Object { $_ })
  $kept = @($entries | Where-Object { $_.TrimEnd('\') -ne $bin })
  if ($kept.Count -ne $entries.Count) {
    $envKey.SetValue('Path', ($kept -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    # Setting and clearing a variable tells open programs that PATH changed.
    [Environment]::SetEnvironmentVariable('NOMAD_INSTALLER_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('NOMAD_INSTALLER_REFRESH', $null, 'User')
  }
  $envKey.Close()
}

# The program. A Nomad window that is closing can hold a file for a moment, so try a few times.
for ($i = 0; $i -lt 20 -and (Test-Path -LiteralPath $root); $i++) {
  try { Remove-Item -LiteralPath $root -Recurse -Force } catch { Start-Sleep -Milliseconds 500 }
}
$failed = Test-Path -LiteralPath $root

# Library, backups and history, only when asked.
$dataRemoved = $false
if ($RemoveData -and (Test-Path -LiteralPath $DataDir)) {
  $full = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
  $unsafe = @([IO.Path]::GetPathRoot($full).TrimEnd('\'), $HOME.TrimEnd('\'), $env:USERPROFILE.TrimEnd('\'))
  if ($unsafe -contains $full) {
    Write-Host "Not deleting $full : it is not a Nomad data folder."
  } else {
    Remove-Item -LiteralPath $full -Recurse -Force -ErrorAction SilentlyContinue
    $dataRemoved = -not (Test-Path -LiteralPath $full)
  }
}

if ($failed) {
  Write-Host "Some files could not be removed. Close Nomad, then delete this folder: $root"
  Finish 1
}
Write-Host 'Nomad has been removed.'
if ($dataRemoved) { Write-Host 'Its library, backups and history were deleted.' }
elseif (Test-Path -LiteralPath $DataDir) { Write-Host "Your library, backups and history are still in $DataDir." }
Finish 0
