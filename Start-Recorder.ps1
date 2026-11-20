[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [ValidateSet('setup', 'list', 'record', 'events', 'watch', 'battery', 'ntfy-setup', 'ntfy-test', 'check')]
    [string]$Mode = 'list',
    [string]$Camera = '',
    [ValidateRange(5, 120)]
    [int]$Seconds = 30
)

$ErrorActionPreference = 'Stop'
# PowerShell 7 parents can pass Core module paths to Windows PowerShell 5.1.
# Resolve the native security module first for DPAPI and SecureString cmdlets.
if ($PSVersionTable.PSVersion.Major -eq 5) {
    $env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
}
Set-Location $PSScriptRoot
$stateDir = Join-Path $env:LOCALAPPDATA 'EufyRecorder'
$credentialFile = Join-Path $stateDir 'credential.xml'
$ntfyTokenFile = Join-Path $stateDir 'ntfy-token.txt'
$configFile = Join-Path $PSScriptRoot 'recorder.json'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Install Node.js 24 LTS, reopen PowerShell, and retry.'
}
$nodeVersion = [version]((& node --version).Trim().TrimStart('v'))
if ($nodeVersion -lt [version]'24.5.0') {
    throw "Node.js 24.5.0 or newer is required; found $nodeVersion."
}

if ($Mode -eq 'check') {
    & node src/cli.ts check
    exit $LASTEXITCODE
}

if ($Mode -eq 'setup') {
    if (Test-Path -LiteralPath $configFile) {
        $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    } else {
        $config = Get-Content recorder.example.json -Raw | ConvertFrom-Json
    }
    $country = (Read-Host "Two-letter country code used for your eufy account [$($config.countryCode)]").Trim().ToUpperInvariant()
    if (-not $country) { $country = $config.countryCode }
    if ($country -notmatch '^[A-Z]{2}$') { throw 'Use a two-letter country code.' }
    $config.countryCode = $country
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configFile -Encoding UTF8
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    $email = Read-Host 'Eufy account email'
    $password = Read-Host 'Eufy app password (saved with Windows encryption for this Windows user)' -AsSecureString
    $credential = New-Object System.Management.Automation.PSCredential($email, $password)
    $credential | Export-Clixml -LiteralPath $credentialFile
    Write-Host 'Credential saved locally. Connecting to list your cameras; enter any verification code here.'
    $Mode = 'list'
}

if (-not (Test-Path -LiteralPath $configFile)) {
    if ($Mode -in @('ntfy-setup', 'ntfy-test')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'recorder.example.json') -Destination $configFile
    } else {
        throw 'Run .\Start-Recorder.ps1 setup to connect your eufy account first.'
    }
}
if ($Mode -eq 'ntfy-setup') {
    $config = Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json
    $server = (Read-Host 'ntfy server URL [https://ntfy.sh]').Trim()
    if (-not $server) { $server = 'https://ntfy.sh' }
    $topic = (Read-Host 'ntfy topic (blank creates a random topic)').Trim()
    if (-not $topic) { $topic = 'eufy-' + [guid]::NewGuid().ToString('N') }
    if ($topic -notmatch '^[a-zA-Z0-9_-]{1,64}$') {
        throw 'Topic must contain 1-64 letters, digits, underscores, or hyphens.'
    }
    $token = Read-Host 'Optional ntfy access token (blank for none)' -AsSecureString
    New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
    if ($token.Length -gt 0) {
        $token | ConvertFrom-SecureString | Set-Content -LiteralPath $ntfyTokenFile -Encoding UTF8
    } elseif (Test-Path -LiteralPath $ntfyTokenFile) {
        Remove-Item -LiteralPath $ntfyTokenFile
    }
    $config | Add-Member -NotePropertyName ntfy -NotePropertyValue ([pscustomobject]@{
        server = $server.TrimEnd('/'); topic = $topic
    }) -Force
    $config | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configFile -Encoding UTF8
    Write-Host "Subscribe to $($server.TrimEnd('/'))/$topic in the ntfy Android app."
    Write-Host 'Then run .\Start-Recorder.ps1 ntfy-test to send a test notification.'
    exit 0
}
if ($Mode -ne 'ntfy-test' -and -not (Test-Path -LiteralPath $credentialFile)) {
    throw 'Run .\Start-Recorder.ps1 setup first.'
}
if (-not (Test-Path node_modules/@mega-yfue/eufy-sdk)) {
    throw 'Run npm ci in this directory first.'
}

$previousEmail = $env:EUFY_EMAIL
$previousPassword = $env:EUFY_PASSWORD
$previousState = $env:EUFY_STATE_DIR
$previousNtfyToken = $env:NTFY_TOKEN
try {
    if ($Mode -ne 'ntfy-test') {
        $credential = Import-Clixml -LiteralPath $credentialFile
        $env:EUFY_EMAIL = $credential.UserName
        $env:EUFY_PASSWORD = $credential.GetNetworkCredential().Password
    }
    if (Test-Path -LiteralPath $ntfyTokenFile) {
        $secureToken = Get-Content -LiteralPath $ntfyTokenFile -Raw | ConvertTo-SecureString
        $tokenCredential = New-Object System.Management.Automation.PSCredential('ntfy', $secureToken)
        $env:NTFY_TOKEN = $tokenCredential.GetNetworkCredential().Password
    }
    $env:EUFY_STATE_DIR = $stateDir
    $nodeArgs = @('src/cli.ts', $Mode)
    if ($Camera) { $nodeArgs += @('--camera', $Camera) }
    if ($Mode -eq 'record') { $nodeArgs += @('--seconds', "$Seconds") }
    & node @nodeArgs
    $result = $LASTEXITCODE
} finally {
    $env:EUFY_EMAIL = $previousEmail
    $env:EUFY_PASSWORD = $previousPassword
    $env:EUFY_STATE_DIR = $previousState
    $env:NTFY_TOKEN = $previousNtfyToken
}
exit $result
