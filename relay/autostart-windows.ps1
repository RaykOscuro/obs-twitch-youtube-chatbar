<#
.SYNOPSIS
  Starts the chat relay automatically on the streaming PC.

.DESCRIPTION
  Registers a Scheduled Task that launches relay/server.mjs at logon, with
  no console window, so nothing needs starting by hand before a stream.

  Run this ON THE STREAMING PC, from the folder it lives in:

      powershell -ExecutionPolicy Bypass -File .\relay\autostart-windows.ps1

.PARAMETER Port
  Port to listen on. Default 8788.

.PARAMETER Supervised
  Register as a SYSTEM task started at boot instead of at logon, with automatic
  restart if it stops. Survives sign-out and restarts on failure, but needs an
  elevated PowerShell and runs with more privilege than the relay needs.

.PARAMETER Uninstall
  Remove the task again.

.EXAMPLE
  .\relay\autostart-windows.ps1
.EXAMPLE
  .\relay\autostart-windows.ps1 -Port 9000
.EXAMPLE
  .\relay\autostart-windows.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [int]$Port = 8788,
  [switch]$Supervised,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'obs-twitch-youtube-chatbar'

$relayDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $relayDir
$serverScript = Join-Path $relayDir 'server.mjs'
$launcher = Join-Path $relayDir 'start-hidden.vbs'

# ----------------------------------------------------------------- uninstall

if ($Uninstall) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $existing) {
    Write-Host "No task named '$TaskName' is registered - nothing to remove."
    return
  }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed the '$TaskName' task."
  Write-Host "A relay already running stays up until you reboot or stop node.exe."
  return
}

# ------------------------------------------------------------------- checks

if (-not (Test-Path $serverScript)) {
  throw "Cannot find $serverScript - run this script from inside the project folder."
}
if (-not (Test-Path $launcher)) {
  throw "Cannot find $launcher - it should sit next to this script."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  throw "Node.js is not on PATH. Install the LTS build from https://nodejs.org and try again."
}
Write-Host "Node found: $($node.Source)"

$inUse = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($inUse) {
  Write-Warning "Port $Port is already in use. Pick another with -Port, or stop whatever holds it."
}

# ---------------------------------------------------------------- register

$settingsArgs = @{
  AllowStartIfOnBatteries    = $true
  DontStopIfGoingOnBatteries = $true
  StartWhenAvailable         = $true
  ExecutionTimeLimit         = (New-TimeSpan -Seconds 0)   # no time limit
}

if ($Supervised) {
  # Node runs directly so Task Scheduler can see the process and restart it.
  # As SYSTEM there is no interactive session, so no window appears either.
  $action = New-ScheduledTaskAction -Execute $node.Source `
    -Argument ('"{0}" {1}' -f $serverScript, $Port) -WorkingDirectory $projectRoot
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet @settingsArgs `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force `
    -Description 'Twitch/YouTube chat relay and overlay for OBS' | Out-Null

  Write-Host "Registered '$TaskName' as a SYSTEM task, started at boot, restarting on failure."
} else {
  # The VBS wrapper is what keeps the console window from appearing.
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' `
    -Argument ('"{0}" {1}' -f $launcher, $Port) -WorkingDirectory $projectRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $settings = New-ScheduledTaskSettingsSet @settingsArgs

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Force `
    -Description 'Twitch/YouTube chat relay and overlay for OBS' | Out-Null

  Write-Host "Registered '$TaskName', started hidden at logon."
}

# ------------------------------------------------------------------- finish

Write-Host ""
Write-Host "Start it now without rebooting:"
Write-Host "    Start-ScheduledTask -TaskName $TaskName"
Write-Host ""
Write-Host "Then set youtube.relayUrl in overlay\config.js:"
Write-Host "    `"relayUrl`": `"http://localhost:$Port`""
Write-Host ""
Write-Host "In OBS, load overlay\index.html as a local file."
Write-Host ""
Write-Host "Check it is up:   Invoke-RestMethod http://localhost:$Port/diag?channel=@YourHandle"
Write-Host "Remove it again:  .\relay\autostart-windows.ps1 -Uninstall"
