[CmdletBinding()]
param([string]$Address = '')
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -eq 5) {
    $env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
}
if (-not $Address) {
    $gateway = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1
    if (-not $gateway) { throw 'Pass -Address with the local router URL.' }
    $Address = 'http://' + $gateway.IPv4DefaultGateway.NextHop
}
$uri = [uri]$Address
if ($uri.Scheme -notin @('http', 'https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
    throw 'Use a local router HTTP or HTTPS URL without embedded credentials.'
}
Write-Host "Save the LOCAL router administrator login for $Address."
Write-Host 'Use the credentials for the router page, rather than your ISP customer portal.'
$username = (Read-Host 'Router username').Trim()
if (-not $username) { throw 'Enter the router username.' }
$password = Read-Host 'Router password' -AsSecureString
$credential = New-Object Management.Automation.PSCredential($username, $password)
$folder = Join-Path $env:LOCALAPPDATA 'EufyRecorder'
New-Item -ItemType Directory -Path $folder -Force | Out-Null
$credential | Export-Clixml -LiteralPath (Join-Path $folder 'router-credential.xml')
@{ address = $uri.GetLeftPart([UriPartial]::Authority) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $folder 'router-settings.json') -Encoding UTF8
Write-Host 'Router credentials saved with Windows encryption for this user.'
Write-Host 'No router login was attempted and no router settings were changed.'
