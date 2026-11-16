# Nomad installer for Windows.
#
#   irm https://thenomad.website/install.ps1 | iex
#
# What it does: downloads Nomad for your system from the project's GitHub releases, checks it
# against its published SHA-256 fingerprint, and installs it in your user folder. No admin rights.
# It adds the nomad command, a Nomad shortcut in the Start menu, and an entry in
# Settings > Apps so you can remove it like any app. It does not touch your agents.
#
# Options, as environment variables:
#   $env:NOMAD_INSTALL_VERSION = '0.5.0'   install this version instead of the newest
#   $env:NOMAD_INSTALL_NO_OPEN = '1'       do not open Nomad at the end

function Install-Nomad {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # the progress bar makes downloads much slower in Windows PowerShell
  $repo = 'kadiri-seer/nomad'

  if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'This installer is for Windows. On Mac or Linux, run: curl -fsSL https://thenomad.website/install.sh | sh'
  }
  if ([Environment]::OSVersion.Version.Major -lt 10) { throw 'Nomad needs Windows 10 or newer.' }
  # Older Windows PowerShell may not offer TLS 1.2 by default, and GitHub requires it.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # Which system: ask the processor itself, so an emulated PowerShell still gets the right build.
  $arch = $null
  try {
    switch ((Get-CimInstance -ClassName Win32_Processor | Select-Object -First 1).Architecture) {
      9 { $arch = 'x64' }
      12 { $arch = 'arm64' }
    }
  } catch { }
  if (-not $arch) {
    $name = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($name) { 'AMD64' { $arch = 'x64' } 'ARM64' { $arch = 'arm64' } }
  }
  if (-not $arch) { throw 'This processor is not supported yet. You can use npm instead: npm install -g thenomad' }
  $target = "windows-$arch"
  $asset = "nomad-$target.zip"

  # Which version
  $source = $env:NOMAD_INSTALL_SOURCE # a folder or https:// address holding the release files, for testing
  if ($env:NOMAD_INSTALL_VERSION) {
    $version = $env:NOMAD_INSTALL_VERSION
  } elseif ($source) {
    throw 'Set NOMAD_INSTALL_VERSION together with NOMAD_INSTALL_SOURCE.'
  } else {
    Write-Host 'Finding the newest Nomad...'
    try { $release = Invoke-RestMethod -UseBasicParsing -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'nomad-installer' } }
    catch { throw 'Could not reach GitHub. Check your connection and try again.' }
    $version = ([string]$release.tag_name) -replace '^v', ''
  }
  if ($version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { throw 'Could not tell which version to install.' }
  if (-not $source) { $source = "https://github.com/$repo/releases/download/v$version" }

  $root = Join-Path $env:LOCALAPPDATA 'Programs\Nomad'
  $bin = Join-Path $root 'bin'
  # Never install into, or later delete, a folder that holds something else.
  if (Test-Path -LiteralPath $root) {
    $foreign = Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -notin @('app', 'bin', 'current', 'install.json', 'update.lock') -and $_.Name -notlike 'tmp-*' -and $_.Name -notlike 'current.*' }
    if ($foreign) { throw "$root already holds files that are not from this installer, so nothing was changed." }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $root 'app'), $bin | Out-Null
  $work = Join-Path $root ('tmp-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Path $work | Out-Null

  try {
    # Download and check
    Write-Host "Downloading Nomad $version for $target..."
    foreach ($file in @('SHA256SUMS', $asset)) {
      $to = Join-Path $work $file
      if ($source -match '^https://') {
        try { Invoke-WebRequest -UseBasicParsing -Uri "$source/$file" -OutFile $to -Headers @{ 'User-Agent' = 'nomad-installer' } }
        catch { throw "Could not download $file. Check your connection and try again." }
      } else {
        Copy-Item -LiteralPath (Join-Path $source $file) -Destination $to
      }
    }
    $expected = $null
    foreach ($line in Get-Content -LiteralPath (Join-Path $work 'SHA256SUMS')) {
      if ($line -match '^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$' -and $Matches[2] -eq $asset) { $expected = $Matches[1].ToLowerInvariant() }
    }
    if (-not $expected) { throw "The release has no fingerprint for $asset." }
    $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $work $asset)).Hash.ToLowerInvariant()
    if ($actual -ne $expected) { throw 'The download does not match its published fingerprint. Nothing was changed.' }
    Write-Host 'Fingerprint checked.'

    # Unpack straight into its own version folder, next to any version already installed, and check
    # it runs before switching to it. (No folder move: antivirus scanners can make a move half-fail.)
    $app = Join-Path $root "app\$version"
    if (Test-Path -LiteralPath $app) {
      try { Remove-Item -LiteralPath $app -Recurse -Force }
      catch { throw 'Nomad is open. Close the Nomad window, then run the installer again.' }
    }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory((Join-Path $work $asset), $app)
    $ok = $false
    try {
      foreach ($need in @('node.exe', 'launcher\nomad.cmd', 'launcher\uninstall.ps1', 'node_modules\thenomad\dist\nomad.js')) {
        if (-not (Test-Path -LiteralPath (Join-Path $app $need))) { throw "The download is incomplete ($need is missing)." }
      }
      $got = & (Join-Path $app 'node.exe') (Join-Path $app 'node_modules\thenomad\dist\nomad.js') --version
      if ($LASTEXITCODE -ne 0) { throw "The downloaded Nomad did not start: $got" }
      if ("$got".Trim() -ne $version) { throw "The download says it is version $got, not $version." }
      $ok = $true
    } finally {
      if (-not $ok) { Remove-Item -LiteralPath $app -Recurse -Force -ErrorAction SilentlyContinue }
    }

    Get-ChildItem -LiteralPath (Join-Path $app 'launcher') -File | Copy-Item -Destination $bin -Force
    [IO.File]::WriteAllText((Join-Path $work 'current'), $version)
    Move-Item -LiteralPath (Join-Path $work 'current') -Destination (Join-Path $root 'current') -Force
    $info = [ordered]@{ by = 'nomad-installer'; target = $target; version = $version }
    [IO.File]::WriteAllText((Join-Path $root 'install.json'), (($info | ConvertTo-Json) + "`n"))
    foreach ($old in Get-ChildItem -LiteralPath (Join-Path $root 'app') -Directory) {
      if ($old.Name -ne $version) { Remove-Item -LiteralPath $old.FullName -Recurse -Force -ErrorAction SilentlyContinue }
    }
  } finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }

  # The nomad command: add Nomad's folder to your PATH, keeping every other entry as it was.
  $other = Get-Command nomad -ErrorAction SilentlyContinue | Where-Object { $_.Source -and -not $_.Source.StartsWith($bin, [StringComparison]::OrdinalIgnoreCase) } | Select-Object -First 1
  $envKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $path = [string]$envKey.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  $entries = @($path -split ';' | Where-Object { $_ })
  if (-not ($entries | Where-Object { $_.TrimEnd('\') -eq $bin })) {
    $envKey.SetValue('Path', (($entries + $bin) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
    # Setting and clearing a variable tells open programs that PATH changed.
    [Environment]::SetEnvironmentVariable('NOMAD_INSTALLER_REFRESH', '1', 'User')
    [Environment]::SetEnvironmentVariable('NOMAD_INSTALLER_REFRESH', $null, 'User')
  }
  $envKey.Close()
  if (-not (($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -eq $bin })) { $env:Path = "$env:Path;$bin" }

  # Start menu shortcut. It opens a small window running Nomad: close that window to stop it.
  # A shortcut called Nomad that opens another program is left alone.
  $shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Nomad.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $link = $shell.CreateShortcut($shortcut)
  $hasShortcut = $true
  if ((Test-Path -LiteralPath $shortcut) -and $link.TargetPath -and -not $link.TargetPath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) {
    $hasShortcut = $false
    Write-Host "Note: the Start menu already has a Nomad shortcut for another program, so it was left alone."
  } else {
    $link.TargetPath = Join-Path $bin 'nomad-app.cmd'
    $link.WorkingDirectory = $HOME
    $link.IconLocation = (Join-Path $bin 'nomad.ico') + ',0'
    $link.Description = 'Move your AI agents between platforms'
    $link.WindowStyle = 7
    $link.Save()
  }

  # Settings > Apps entry, so Nomad can be removed like any app.
  $appsKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\thenomad.website'
  New-Item -Path $appsKey -Force | Out-Null
  $size = [int]((Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum).Sum / 1KB)
  $uninstall = Join-Path $bin 'uninstall.ps1'
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $values = [ordered]@{
    DisplayName = 'Nomad'
    DisplayVersion = $version
    Publisher = 'kadiri-seer'
    DisplayIcon = Join-Path $bin 'nomad.ico'
    InstallLocation = $root
    URLInfoAbout = 'https://thenomad.website'
    HelpLink = 'https://github.com/kadiri-seer/nomad'
    UninstallString = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$uninstall`""
    QuietUninstallString = "`"$ps`" -NoProfile -ExecutionPolicy Bypass -File `"$uninstall`" -Yes"
  }
  foreach ($k in $values.Keys) { New-ItemProperty -Path $appsKey -Name $k -Value $values[$k] -PropertyType String -Force | Out-Null }
  foreach ($k in @('NoModify', 'NoRepair')) { New-ItemProperty -Path $appsKey -Name $k -Value 1 -PropertyType DWord -Force | Out-Null }
  New-ItemProperty -Path $appsKey -Name 'EstimatedSize' -Value $size -PropertyType DWord -Force | Out-Null

  Write-Host ''
  Write-Host "Nomad $version is installed." -ForegroundColor Green
  if ($hasShortcut) { Write-Host 'Open it any time from Nomad in the Start menu.' } else { Write-Host 'Open it any time with: nomad ui' }
  Write-Host 'In a terminal, type: nomad'
  Write-Host 'Remove it from Settings > Apps, or with: nomad uninstall'
  if ($other) { Write-Host "Note: another program called nomad is at $($other.Source). Typing nomad runs whichever comes first in your PATH; the Start menu shortcut is not affected." }
  if (-not $env:NOMAD_INSTALL_NO_OPEN) {
    Write-Host 'Opening Nomad...'
    if ($hasShortcut) { Start-Process -FilePath $shortcut } else { Start-Process -FilePath (Join-Path $bin 'nomad-app.cmd') }
  }
}

try {
  Install-Nomad
} catch {
  Write-Host "Nomad was not installed: $($_.Exception.Message)" -ForegroundColor Red
} finally {
  Remove-Item -Path Function:\Install-Nomad -ErrorAction SilentlyContinue
}
