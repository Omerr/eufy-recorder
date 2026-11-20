[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 400)]
    [string]$Text,
    [string]$OutputPath = '.\audio\visitor.aac',
    [string]$Ffmpeg = 'ffmpeg',
    [string]$Voice = ''
)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -eq 5) {
    $env:PSModulePath = (Join-Path $PSHOME 'Modules') + ';' + $env:PSModulePath
}
if (-not (Get-Command $Ffmpeg -ErrorAction SilentlyContinue)) {
    throw 'Install FFmpeg or pass -Ffmpeg with its executable path. Camera recording itself needs no FFmpeg.'
}
Add-Type -AssemblyName System.Speech
$target = if ([IO.Path]::IsPathRooted($OutputPath)) { $OutputPath } else { Join-Path $PSScriptRoot $OutputPath }
$output = [IO.Path]::GetFullPath($target)
New-Item -ItemType Directory -Path (Split-Path $output) -Force | Out-Null
$temporary = Join-Path ([IO.Path]::GetTempPath()) ('eufy-speech-' + [guid]::NewGuid().ToString('N') + '.wav')
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    if ($Voice) { $speaker.SelectVoice($Voice) }
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
    $speaker.SetOutputToWaveFile($temporary, $format)
    $speaker.Speak($Text)
    $speaker.SetOutputToNull()
    & $Ffmpeg -hide_banner -loglevel error -y -i $temporary -ac 1 -ar 16000 -c:a aac -b:a 16k -f adts $output
    if ($LASTEXITCODE -ne 0) { throw 'FFmpeg conversion failed.' }
    Write-Host "Saved local speech clip: $output"
} finally {
    $speaker.Dispose()
    if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary }
}
