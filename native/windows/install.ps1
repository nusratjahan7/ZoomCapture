<#
.SYNOPSIS
  Installs (or removes) the ZoomCapture floating controls helper for Windows.

.DESCRIPTION
  Compiles ZoomCaptureControls.cs with the C# compiler that ships with Windows (.NET Framework 4),
  copies it to %LOCALAPPDATA%\ZoomCapture\NativeControls, and registers it as a Chrome / Edge
  native messaging host for your ZoomCapture extension only. Everything is per user: no
  administrator rights, nothing outside your user profile and HKEY_CURRENT_USER.

  The helper shows the recording controls in a small always-on-top window that Windows leaves out
  of screen captures, so they are on your screen but not in recordings of your entire screen
  (Windows 10 version 2004 or later).

.PARAMETER ExtensionId
  ZoomCapture's extension ID, shown in ZoomCapture Settings (and on chrome://extensions).
  Several IDs can be given, separated by commas.

.PARAMETER Uninstall
  Removes the helper and its registration.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File native\windows\install.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop
#>
param(
  [string[]]$ExtensionId = @(),
  [switch]$Uninstall,
  # Only compile into -InstallDir (no registration); used by tests.
  [switch]$BuildOnly,
  # Where the helper is installed (tests use a temporary folder).
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'ZoomCapture\NativeControls')
)

$ErrorActionPreference = 'Stop'
$hostName = 'com.zoomcapture.controls'
$registryKeys = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Chromium\NativeMessagingHosts\$hostName"
)

if ($Uninstall) {
  foreach ($key in $registryKeys) {
    if (Test-Path $key) { Remove-Item -Path $key -Force }
  }
  if (Test-Path $InstallDir) { Remove-Item -Path $InstallDir -Recurse -Force }
  Write-Host 'ZoomCapture controls helper removed.'
  exit 0
}

function Build-Helper {
  # Compile with the .NET Framework compiler that comes with Windows.
  $csc = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
  if (-not (Test-Path $csc)) { throw "The C# compiler that comes with Windows was not found at $csc." }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  $exe = Join-Path $InstallDir 'ZoomCaptureControls.exe'
  $source = Join-Path $PSScriptRoot 'ZoomCaptureControls.cs'
  $output = & $csc /nologo /target:winexe /optimize+ "/out:$exe" /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll $source 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Building the helper failed:`n$($output -join "`n")" }
  return $exe
}

if ($BuildOnly) {
  $exe = Build-Helper
  Write-Host $exe
  exit 0
}

$ids = @($ExtensionId | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($ids.Count -eq 0) { throw 'Give your ZoomCapture extension ID: -ExtensionId <id> (shown in ZoomCapture Settings).' }
foreach ($id in $ids) {
  if ($id -notmatch '^[a-p]{32}$') { throw "'$id' is not an extension ID (32 letters a-p, shown in ZoomCapture Settings)." }
}

$build = [Environment]::OSVersion.Version.Build
if ($build -lt 19041) {
  Write-Warning "Windows build $build can't leave windows out of screen captures (needs Windows 10 version 2004, build 19041, or later). The controls would appear in recordings."
}

$exe = Build-Helper

# The native messaging host manifest: only the given extension(s) may start the helper.
$manifest = [ordered]@{
  name            = $hostName
  description     = 'ZoomCapture floating controls (left out of screen recordings)'
  path            = $exe
  type            = 'stdio'
  allowed_origins = @($ids | ForEach-Object { "chrome-extension://$_/" })
}
$manifestPath = Join-Path $InstallDir "$hostName.json"
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

foreach ($key in $registryKeys) {
  New-Item -Path $key -Value $manifestPath -Force | Out-Null
}

Write-Host "ZoomCapture controls helper installed in $InstallDir"
Write-Host "Allowed extension(s): $($ids -join ', ')"
Write-Host 'In ZoomCapture Settings, click "Check again".'
