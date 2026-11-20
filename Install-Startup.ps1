[CmdletBinding()]
param([switch]$StartNow)
$ErrorActionPreference = 'Stop'
$taskName = 'Eufy Recorder'
$runner = Join-Path $PSScriptRoot 'Run-Background.ps1'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing -and ($existing.Actions.Arguments -notlike ('*' + $runner + '*'))) {
    throw 'An unrelated task named Eufy Recorder already exists; leaving it unchanged.'
}
$action = New-ScheduledTaskAction -Execute "$PSHOME\powershell.exe" -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $runner + '"') -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Motion recording and battery alerts for selected eufy cameras. Starts when this Windows user signs in.' -Force | Out-Null
if ($StartNow) { Start-ScheduledTask -TaskName $taskName }
Write-Host 'Installed Eufy Recorder startup task. It runs while this Windows user is signed in, including when the screen is locked.'
Write-Host 'After reboot, recording starts when you sign in. Logs: %LOCALAPPDATA%\EufyRecorder\logs'
