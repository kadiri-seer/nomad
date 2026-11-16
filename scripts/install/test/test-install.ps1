# Installs Nomad from freshly built bundles with the real install.ps1 (run the way irm | iex runs it),
# uses it, and removes it again, both through nomad uninstall and through the Settings > Apps entry.
# Runs in CI on Windows, in Windows PowerShell 5.1 like most people have.
#
#   powershell -File scripts/install/test/test-install.ps1 -Dist <folder> -Version <x.y.z>
param(
  [Parameter(Mandatory = $true)][string]$Dist,
  [Parameter(Mandatory = $true)][string]$Version
)
# Continue, not Stop: Windows PowerShell turns a program's error output into a stop, and the checks below handle failures.
$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $PSScriptRoot
$Dist = (Resolve-Path -LiteralPath $Dist).Path
$script:failures = 0
function Ok([string]$label) { Write-Host "ok    $label" }
function Bad([string]$label) { Write-Host "FAIL  $label"; $script:failures++ }
function Check([string]$label, [scriptblock]$test) {
  $result = $false
  try { $result = [bool](& $test) } catch { $result = $false }
  if ($result) { Ok $label } else { Bad $label }
}

$root = Join-Path $env:LOCALAPPDATA 'Programs\Nomad'
$bin = Join-Path $root 'bin'
$cmd = Join-Path $bin 'nomad.cmd'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nomad.lnk'
$appsKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Nomad'
$data = Join-Path $HOME '.nomad'
$env:NOMAD_INSTALL_SOURCE = $Dist
$env:NOMAD_INSTALL_VERSION = $Version
$env:NOMAD_INSTALL_NO_OPEN = '1'
function UserPath { [string]([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')) }
function PathCount { @((UserPath) -split ';' | Where-Object { $_.TrimEnd('\') -eq $bin }).Count }
# Exactly what irm ... | iex does: run the script text in this session.
function Install([string]$source = $Dist) {
  $env:NOMAD_INSTALL_SOURCE = $source
  $text = Get-Content -Raw -LiteralPath (Join-Path $here 'install.ps1')
  $out = Invoke-Expression $text 6>&1 | Out-String
  $env:NOMAD_INSTALL_SOURCE = $Dist
  return $out
}
function WaitGone([string]$path) {
  for ($i = 0; $i -lt 120 -and (Test-Path -LiteralPath $path); $i++) { Start-Sleep -Milliseconds 500 }
  return -not (Test-Path -LiteralPath $path)
}

Write-Host '== the scripts parse'
foreach ($f in @('install.ps1', 'windows\uninstall.ps1')) {
  $errors = $null
  [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $here $f), [ref]$null, [ref]$errors)
  Check "$f has no syntax errors" { $errors.Count -eq 0 }
}

Write-Host '== install'
$out = Install
Write-Host $out
Check "the nomad command runs version $Version" { (& $cmd --version) -eq $Version -and $LASTEXITCODE -eq 0 }
Check 'the install folder has one version' { (@(Get-ChildItem -LiteralPath (Join-Path $root 'app') -Directory | ForEach-Object { $_.Name }) -join ',') -eq $Version }
Check 'install.json names the installer' { (Get-Content -Raw (Join-Path $root 'install.json') | ConvertFrom-Json).by -eq 'nomad-installer' }
Check 'PATH has Nomad once' { (PathCount) -eq 1 }
Check 'this window finds the nomad command' { (Get-Command nomad).Source -eq $cmd }
Check 'Start menu shortcut exists' { Test-Path -LiteralPath $shortcut }
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
Check 'the shortcut opens the Nomad window' { $link.TargetPath -eq (Join-Path $bin 'nomad-app.cmd') }
Check 'the shortcut has the Nomad icon' { $link.IconLocation -like '*nomad.ico,0' -and (Test-Path -LiteralPath (Join-Path $bin 'nomad.ico')) }
Check 'Settings > Apps lists Nomad with its version' { (Get-ItemProperty $appsKey).DisplayVersion -eq $Version }
Check 'Settings > Apps can remove it' { (Get-ItemProperty $appsKey).UninstallString -like '*uninstall.ps1*' }

Write-Host '== install again (repair)'
[void](Install)
Check 'still runs' { (& $cmd --version) -eq $Version }
Check 'PATH still has Nomad once' { (PathCount) -eq 1 }
Check 'no temporary folders left' { @(Get-ChildItem -LiteralPath $root -Directory -Filter 'tmp-*').Count -eq 0 }

Write-Host '== use it'
Check 'the library opens (database module works)' { & $cmd list --json | Out-Null; $LASTEXITCODE -eq 0 }
Check 'a failing command reports failure' { & $cmd validate (Join-Path $env:TEMP 'not-there.nomad') 2>&1 | Out-Null; $LASTEXITCODE -ne 0 }
$spaced = Join-Path $env:TEMP 'a folder with spaces'
Check 'arguments with spaces reach Nomad' { & $cmd --home $spaced list --json | Out-Null; $LASTEXITCODE -eq 0 }
Check 'the folder with spaces was used' { Test-Path -LiteralPath $spaced }

Write-Host '== open the dashboard twice (the second finds the next port)'
$log1 = Join-Path $env:TEMP 'nomad-ui1.log'
$log2 = Join-Path $env:TEMP 'nomad-ui2.log'
$ui1 = Start-Process -FilePath $cmd -ArgumentList 'ui', '--app', '--no-open' -RedirectStandardError $log1 -RedirectStandardOutput "$log1.out" -PassThru
for ($i = 0; $i -lt 60 -and -not ((Get-Content -Raw $log1 -ErrorAction SilentlyContinue) -match 'is open at'); $i++) { Start-Sleep 1 }
$ui2 = Start-Process -FilePath $cmd -ArgumentList 'ui', '--app', '--no-open' -RedirectStandardError $log2 -RedirectStandardOutput "$log2.out" -PassThru
for ($i = 0; $i -lt 60 -and -not ((Get-Content -Raw $log2 -ErrorAction SilentlyContinue) -match 'is open at'); $i++) { Start-Sleep 1 }
$url1 = [regex]::Match((Get-Content -Raw $log1), 'http://127\.0\.0\.1:\d+/app/session\?token=[A-Za-z0-9_-]+').Value
$url2 = [regex]::Match((Get-Content -Raw $log2), 'http://127\.0\.0\.1:\d+/app/session\?token=[A-Za-z0-9_-]+').Value
Check 'the first window says how to stop' { (Get-Content -Raw $log1) -match 'close it to stop' }
Check 'the second window uses another port' { $url2 -and ($url1 -replace '/app.*', '') -ne ($url2 -replace '/app.*', '') }
$base = $url1 -replace '/app.*', ''
try {
  [void](Invoke-WebRequest -UseBasicParsing -Uri $url1 -SessionVariable web -MaximumRedirection 5)
  $status = (Invoke-WebRequest -UseBasicParsing -Uri "$base/api/app/update" -WebSession $web).Content
} catch { $status = "$_" }
Check "the dashboard knows it can update ($status)" { $status -eq "{`"installed`":true,`"current`":`"$Version`"}" }
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) } | Stop-Process -Force
foreach ($p in @($ui1, $ui2)) { if (-not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } }
Start-Sleep 2

Write-Host '== a tampered download is refused'
$badDist = Join-Path $env:TEMP 'nomad-bad-dist'
Remove-Item -LiteralPath $badDist -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath $Dist -Destination $badDist -Recurse
Get-ChildItem -LiteralPath $badDist -Filter 'nomad-*.zip' | ForEach-Object { Add-Content -LiteralPath $_.FullName -Value 'x' -Encoding Ascii }
$out = Install $badDist
Check 'tampered download refused, saying why' { $out -match 'does not match its published fingerprint' }
Check 'the installed Nomad still runs' { (& $cmd --version) -eq $Version }

Write-Host '== uninstall with nomad uninstall, keeping the library'
& $cmd uninstall --yes
Check 'program removed' { WaitGone $root }
Check 'Start menu shortcut removed' { -not (Test-Path -LiteralPath $shortcut) }
Check 'Settings > Apps entry removed' { -not (Test-Path $appsKey) }
Check 'PATH entry removed' { (PathCount) -eq 0 }
Check 'library kept' { Test-Path -LiteralPath $data }

Write-Host '== install, then remove from Settings > Apps with the library'
[void](Install)
$quiet = (Get-ItemProperty $appsKey).QuietUninstallString
Check 'Settings > Apps has a quiet uninstall' { $quiet -like '*uninstall.ps1*-Yes' }
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $bin 'uninstall.ps1') -Yes -RemoveData | Out-Host
Check 'program removed' { WaitGone $root }
Check 'library removed' { -not (Test-Path -LiteralPath $data) }
Check 'Settings > Apps entry removed' { -not (Test-Path $appsKey) }

if ($script:failures -gt 0) {
  Write-Host "$($script:failures) check(s) failed."
  exit 1
}
Write-Host 'All install checks passed.'
