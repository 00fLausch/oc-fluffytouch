#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Pair,
    [ValidateRange(1,65535)][int]$Port = 8443,
    [ValidateRange(1,65535)][int]$ProxyPort = 14973,
    [ValidateRange(1,65535)][int]$VoicePort = 14974
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'setup-common.ps1')
try {
    if (-not (Test-Path -LiteralPath $FluffyConfigPath -PathType Leaf)) { throw 'Zuerst .\Install-OCFluffyTouch.ps1 ausfuehren.' }
    $config = Get-Content -LiteralPath $FluffyConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.schema -ne 1 -or $config.mode -notin @('Standalone','OpenCode')) { throw 'Unbekannte Konfiguration. Installation erneut ausfuehren.' }
    $selected = @(Resolve-FluffyFeatures $config.mode $config.features)
    $env:OC_FLUFFYTOUCH_FEATURES = if ($selected.Count) { $selected -join ',' } else { 'none' }
    $env:OC_FLUFFYTOUCH_PROFILE = (Get-FileHash -LiteralPath $FluffyConfigPath -Algorithm SHA256).Hash
    $env:OC_FLUFFYTOUCH_EXPERT_MODEL = if ($selected -contains 'expert') {
        Assert-FluffyExpertModel (Get-FluffyProperty $config 'expertModel')
    } else { $null }
    $asr = $selected -contains 'transcript'
    $tts = $selected -contains 'read-aloud'
    $audioModes = @(if ($asr) { 'asr' }; if ($tts) { 'tts' }) -join ','
    if ($audioModes) {
        if (-not (Test-Path -LiteralPath $config.python -PathType Leaf)) { throw 'Voice-Python fehlt. Installation erneut ausfuehren.' }
        if ($asr) {
            if (-not (Test-FluffyModel $config.modelDir)) { throw 'Parakeet-Dateien fehlen. Installation erneut ausfuehren.' }
            $env:OPENCODE_TOUCH_PARAKEET = $config.modelDir
        }
        if ($tts) { $env:OPENCODE_TOUCH_OMNIVOICE = Assert-FluffyOmniUrl $config.omniVoiceUrl }
    }
    if ($config.mode -eq 'Standalone') {
        if ($Pair) { throw '-Pair gibt es nur fuer die OpenCode-Einbindung.' }
        if (Get-NetTCPConnection -State Listen -LocalPort $VoicePort -ErrorAction SilentlyContinue) { throw "Voice-Port $VoicePort ist belegt. Waehle -VoicePort, ohne den laufenden Dienst zu beenden." }
        Write-Host "Voice-API: http://127.0.0.1:$VoicePort (nur lokal, Strg+C beendet sie)"
        & $config.python -B (Join-Path $PSScriptRoot 'voice-bridge.py') --port $VoicePort --features $audioModes
        exit $LASTEXITCODE
    }
    if ($Port -eq $ProxyPort -or $Port -eq $VoicePort -or $ProxyPort -eq $VoicePort) { throw 'HTTPS-, Proxy- und Voice-Port muessen verschieden sein.' }
    & (Join-Path $PSScriptRoot 'Start-OpenCodeTouch.ps1') -Pair:$Pair -Port $Port -ProxyPort $ProxyPort -VoicePort $VoicePort -VoicePython $config.python -AudioModes $audioModes
    exit $LASTEXITCODE
} catch {
    Write-Host "Start angehalten: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
