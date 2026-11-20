$ErrorActionPreference = 'Stop'
$logs = Join-Path $env:LOCALAPPDATA 'EufyRecorder\logs'
New-Item -ItemType Directory -Path $logs -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$launcher = Join-Path $PSScriptRoot 'Start-Recorder.ps1'
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $launcher + '" watch'
$process = Start-Process -FilePath "$PSHOME\powershell.exe" -ArgumentList $arguments -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $logs "$stamp.log") -RedirectStandardError (Join-Path $logs "$stamp.error.log")
exit $process.ExitCode
