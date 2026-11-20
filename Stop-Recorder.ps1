$ErrorActionPreference = 'Stop'
$state = Join-Path $env:LOCALAPPDATA 'EufyRecorder'
$ownerFile = Join-Path $state 'recorder-lock\owner.json'
if (-not (Test-Path -LiteralPath $ownerFile)) {
    Write-Host 'No recorder instance is registered as running.'
    exit 0
}
$owner = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
if ($owner.nonce -notmatch '^[a-f0-9-]{36}$') { throw 'Invalid recorder instance identifier.' }
$stopFile = Join-Path $state ('stop-' + $owner.nonce)
Set-Content -LiteralPath $stopFile -Value 'stop' -Encoding ASCII
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (-not (Test-Path -LiteralPath $ownerFile)) {
        Write-Host 'Recorder stopped and saved its completed video fragments.'
        exit 0
    }
    $current = Get-Content -LiteralPath $ownerFile -Raw | ConvertFrom-Json
    if ($current.nonce -ne $owner.nonce) {
        Write-Host 'The previous recorder instance has stopped.'
        exit 0
    }
    Start-Sleep -Milliseconds 250
}
throw 'Recorder did not stop within 15 seconds. Inspect its logs before forcing the task to stop.'
