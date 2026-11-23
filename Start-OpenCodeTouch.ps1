#requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$Pair,
    [int]$Port = 8443,
    [int]$ProxyPort = 14973,
    [int]$VoicePort = 14974,
    [string]$VoicePython,
    [string]$AudioModes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-NativeText {
    param([string]$Executable, [string[]]$Arguments)
    $text = (& $Executable @Arguments | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Befehl '$([IO.Path]::GetFileName($Executable)) $($Arguments -join ' ')' fehlgeschlagen (Exitcode $LASTEXITCODE)."
    }
    return $text
}

function Get-Field {
    param($Object, [string]$Name)
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Assert-PrivateRoute {
    param($Config, [string]$Endpoint, [string]$Target, [int]$RoutePort)
    if ($null -eq $Config -or $Config -isnot [pscustomobject]) {
        throw 'Tailscale liefert keine auswertbare Serve-Konfiguration.'
    }
    # Check every hostname on this port, not only the current machine name.
    $funnel = Get-Field $Config 'AllowFunnel'
    if ($null -ne $funnel) {
        foreach ($entry in $funnel.PSObject.Properties) {
            if ($entry.Name -match ":$RoutePort$" -and $entry.Value -ne $false) {
                throw "Funnel auf Port $RoutePort gefunden. Keine Aenderung vorgenommen."
            }
        }
    }
    $tcp = Get-Field (Get-Field $Config 'TCP') "$RoutePort"
    if ($null -ne $tcp) {
        if ((Get-Field $tcp 'HTTPS') -ne $true -or
            $null -ne (Get-Field $tcp 'TCPForward') -or
            (Get-Field $tcp 'HTTP') -eq $true) {
            throw "Port $RoutePort ist bereits anders belegt. Keine Aenderung vorgenommen."
        }
    }
    $found = $false
    $web = Get-Field $Config 'Web'
    if ($null -ne $web) {
        foreach ($entry in $web.PSObject.Properties) {
            if ($entry.Name -notmatch ":$RoutePort$") { continue }
            $handlers = Get-Field $entry.Value 'Handlers'
            $root = Get-Field $handlers '/'
            if ($entry.Name -ne $Endpoint -or $null -eq $handlers -or
                @($handlers.PSObject.Properties).Count -ne 1 -or
                (Get-Field $root 'Proxy') -cne $Target -or
                @($root.PSObject.Properties).Count -ne 1) {
                throw "Port $RoutePort hat ein anderes Ziel oder weitere Handler. Bitte Belegung manuell pruefen; nichts wurde ueberschrieben."
            }
            $found = $true
        }
    }
    if (($null -ne $tcp) -ne $found) {
        throw "Unvollstaendige Belegung auf Port $RoutePort. Bitte manuell pruefen."
    }
    return $found
}

function Get-ServiceTarget {
    param([string]$Cli)
    $status = Invoke-NativeText $Cli @('service', 'status')
    if ($status -notmatch '^http://127\.0\.0\.1:([0-9]{1,5})/?$') {
        throw 'Kein laufender OpenCode-Dienst mit eindeutiger HTTP-Loopback-Adresse gefunden. OpenCode Desktop selbst oeffnen; das Skript startet keinen Dienst.'
    }
    $port = [int]$Matches[1]
    if ($port -lt 1 -or $port -gt 65535) { throw 'Ungueltiger Dienstport.' }
    return "http://127.0.0.1:$port"
}

function Assert-ServiceUnchanged {
    param([string]$Cli, [int]$ProcessId, [datetime]$Started, [string]$Target)
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    if ($process.Path -ne $Cli -or $process.StartTime -ne $Started -or
        (Get-ServiceTarget $Cli) -ne $Target) {
        throw 'OpenCode-Dienst hat sich waehrend der Pruefung geaendert. Bitte erneut ausfuehren.'
    }
}

function Get-LocalHealth([string]$Uri, [int]$Timeout = 2) {
    try { Invoke-RestMethod -Uri $Uri -TimeoutSec $Timeout -MaximumRedirection 0 } catch { }
}

function New-BridgeToken {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [BitConverter]::ToString($bytes).Replace('-','').ToLowerInvariant()
}

$priorBridgeToken = $env:OC_FLUFFYTOUCH_BRIDGE_TOKEN
$voiceProcess = $null
$proxyProcess = $null
$readyForRoute = $false
try {
    if (-not $env:OC_FLUFFYTOUCH_PROFILE) { throw 'Bitte Start-OCFluffyTouch.ps1 verwenden.' }
    $processes = @(Get-Process -Name 'opencode-cli' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and (Test-Path -LiteralPath $_.Path -PathType Leaf) })
    $paths = @($processes | ForEach-Object { $_.Path } | Sort-Object -Unique)
    if ($paths.Count -ne 1 -or $processes.Count -ne 1) {
        throw 'Kein eindeutiger laufender opencode-cli.exe-Prozess gefunden. OpenCode Desktop oeffnen bzw. mehrere Instanzen pruefen.'
    }
    $cli = $paths[0]
    $serviceProcess = $processes[0]
    $started = $serviceProcess.StartTime
    $target = Get-ServiceTarget $cli
    $page = Invoke-WebRequest -Uri "$target/" -UseBasicParsing -TimeoutSec 15 -MaximumRedirection 0
    if ($page.StatusCode -ne 200 -or $page.Content -notmatch '(?i)<html' -or
        $page.Content -notmatch '(?i)opencode') {
        throw 'Die vorhandene Loopback-Adresse liefert nicht die erwartete OpenCode-Weboberflaeche.'
    }
    Assert-ServiceUnchanged $cli $serviceProcess.Id $started $target
    # Native discovery supplies authentication. Never read/copy credentials.
    $info = (Invoke-NativeText $cli @('api', 'get', '/api/info')) | ConvertFrom-Json
    $version = Get-Field $info 'version'
    if ([string]::IsNullOrWhiteSpace([string]$version)) { throw 'API-Info enthaelt keine Version.' }
    if ((Get-Field $info 'pid') -ne $serviceProcess.Id -or
        @(Get-Field $info 'urls') -notcontains $target) {
        throw 'API-Info gehoert nicht zum erwarteten laufenden Dienst.'
    }
    Assert-ServiceUnchanged $cli $serviceProcess.Id $started $target

    $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) { throw 'Tailscale ist nicht unter Program Files installiert.' }
    # Read existing routes BEFORE any configuration command.
    $config = (Invoke-NativeText $tailscale @('serve', 'status', '--json')) | ConvertFrom-Json
    $status = (Invoke-NativeText $tailscale @('status', '--json')) | ConvertFrom-Json
    if ((Get-Field $status 'BackendState') -ne 'Running') { throw 'Tailscale ist nicht verbunden.' }
    $dns = ([string](Get-Field (Get-Field $status 'Self') 'DNSName')).TrimEnd('.')
    if ($dns -notmatch '^[a-zA-Z0-9][a-zA-Z0-9.-]*\.ts\.net$') { throw 'Keine gueltige eigene Tailscale-DNS-Adresse gefunden.' }
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Ungueltiger Serve-Port.' }
    $endpoint = "${dns}:$Port"
    $url = "https://$endpoint"
    $proxyTarget = "http://127.0.0.1:$proxyPort"
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $proxyFile = Join-Path $PSScriptRoot 'mobile-proxy.cjs'
    if (-not (Test-Path -LiteralPath $proxyFile -PathType Leaf)) { throw 'Mobile-Proxy fehlt.' }

    $exists = Assert-PrivateRoute $config $endpoint $proxyTarget $Port
    $servicePort = ([uri]$target).Port
    $proxyHealthUrl = "$proxyTarget/__opencode_touch_health"
    $health = Get-LocalHealth $proxyHealthUrl
    $expectedVoicePort = if ($AudioModes) { $VoicePort }
    function Is-OwnProxy($info) {
        (Get-Field $info 'service') -eq 'oc-fluffytouch-proxy-v2' -and
        (Get-Field $info 'upstreamPort') -eq $servicePort -and
        (Get-Field $info 'profile') -eq $env:OC_FLUFFYTOUCH_PROFILE -and
        (Get-Field $info 'voicePort') -eq $expectedVoicePort
    }
    if ($health -and -not (Is-OwnProxy $health)) {
        throw 'Der mobile Proxy verwendet eine andere Konfiguration oder Sitzung. Belegung manuell pruefen; nichts wurde beendet.'
    }
    if (-not $health -and (Get-NetTCPConnection -State Listen -LocalPort $proxyPort -ErrorAction SilentlyContinue)) {
        throw "Lokaler Proxy-Port $proxyPort ist bereits belegt."
    }
    $voiceHealth = $null
    if ($AudioModes) {
        $voiceHealthUrl = "http://127.0.0.1:$VoicePort/health"
        $voiceHealth = Get-LocalHealth $voiceHealthUrl
        $voicePair = Get-Field $voiceHealth 'pairId'
        if ($health -or $voiceHealth) {
            if (-not $health -or (Get-Field $voiceHealth 'service') -ne 'oc-fluffytouch-voice-v2' -or
                (Get-Field $voiceHealth 'profile') -ne $env:OC_FLUFFYTOUCH_PROFILE -or $voicePair -cnotmatch '^[0-9a-f]{64}$' -or
                $voicePair -cne (Get-Field $health 'pairId')) {
                throw 'Proxy und Voice-Bruecke gehoeren nicht als Paar zusammen. Portbelegung pruefen und nur die zugehoerigen fluffyTouch-Prozesse neu starten.'
            }
        } else {
            if (Get-NetTCPConnection -State Listen -LocalPort $VoicePort -ErrorAction SilentlyContinue) { throw "Lokaler Voice-Port $VoicePort ist bereits belegt." }
            $voiceScript = Join-Path $PSScriptRoot 'voice-bridge.py'
            if (-not (Test-Path -LiteralPath $voiceScript -PathType Leaf) -or -not (Test-Path -LiteralPath $VoicePython -PathType Leaf)) {
                throw 'Voice-Bruecke oder Python fehlt. Einrichtung erneut ausfuehren.'
            }
            # Secret is inherited by new child processes only, never written to disk.
            $env:OC_FLUFFYTOUCH_BRIDGE_TOKEN = New-BridgeToken
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $voicePair = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($env:OC_FLUFFYTOUCH_BRIDGE_TOKEN))).Replace('-','').ToLowerInvariant() }
            finally { $sha.Dispose() }
            $voiceOut = Join-Path $env:TEMP "oc-fluffytouch-$VoicePort-voice.out.log"
            $voiceErr = Join-Path $env:TEMP "oc-fluffytouch-$VoicePort-voice.err.log"
            $voiceProcess = Start-Process -FilePath $VoicePython -ArgumentList @('-B', "`"$voiceScript`"", '--port', "$VoicePort", '--features', $AudioModes) `
                -WindowStyle Hidden -RedirectStandardOutput $voiceOut -RedirectStandardError $voiceErr -PassThru
            for ($attempt = 0; $attempt -lt 60 -and -not $voiceHealth -and -not $voiceProcess.HasExited; $attempt++) {
                Start-Sleep -Milliseconds 300
                $voiceHealth = Get-LocalHealth $voiceHealthUrl 1
            }
        }
        if ((Get-Field $voiceHealth 'status') -ne 'ok' -or (Get-Field $voiceHealth 'service') -ne 'oc-fluffytouch-voice-v2' -or
            (Get-Field $voiceHealth 'profile') -ne $env:OC_FLUFFYTOUCH_PROFILE -or (Get-Field $voiceHealth 'pairId') -cne $voicePair) {
            throw 'Voice-Bruecke konnte nicht verifiziert werden. Pruefe die Ausgabe der lokalen Voice-Bruecke.'
        }
        if ($AudioModes.Contains('asr') -and (-not $voiceHealth.stt.available -or $voiceHealth.stt.status -eq 'error')) {
            throw 'Parakeet ist nicht bereit. Modell und Python-Pakete pruefen.'
        }
    }
    if (-not $health) {
        $proxyProcess = Start-Process -FilePath $node -ArgumentList @("`"$proxyFile`"", "$servicePort", "$proxyPort", "$VoicePort") -WindowStyle Hidden -PassThru
        for ($attempt = 0; $attempt -lt 30 -and -not $health -and -not $proxyProcess.HasExited; $attempt++) {
            Start-Sleep -Milliseconds 200
            $health = Get-LocalHealth $proxyHealthUrl 1
        }
    }
    if (-not (Is-OwnProxy $health) -or ($AudioModes -and (Get-Field $health 'pairId') -cne $voicePair)) {
        throw 'Der mobile Proxy konnte nicht gestartet oder verifiziert werden.'
    }
    $fixedPage = Invoke-WebRequest -Uri "$proxyTarget/" -UseBasicParsing -TimeoutSec 15
    if ($fixedPage.StatusCode -ne 200 -or $fixedPage.Content -notmatch 'opencode-touch-ios-fix') {
        throw 'Mobile HTML-Korrektur ist nicht vorhanden; Route bleibt unveraendert.'
    }
    if ($AudioModes) {
        $worklet = Invoke-WebRequest -Uri "$proxyTarget/__opencode_touch/worklet.js" -UseBasicParsing -TimeoutSec 15
        if ($worklet.StatusCode -ne 200 -or $worklet.Content -notmatch 'capture-processor') {
            throw 'Audio-Worklet ist nicht erreichbar; Route bleibt unveraendert.'
        }
    }
    $readyForRoute = $true
    if (-not $exists) {
        Assert-ServiceUnchanged $cli $serviceProcess.Id $started $target
        $config = (Invoke-NativeText $tailscale @('serve', 'status', '--json')) | ConvertFrom-Json
        $exists = Assert-PrivateRoute $config $endpoint $proxyTarget $Port
        if (-not $exists) {
            $null = Invoke-NativeText $tailscale @('serve', '--bg', "--https=$Port", $proxyTarget)
        }
    }
    $after = (Invoke-NativeText $tailscale @('serve', 'status', '--json')) | ConvertFrom-Json
    if (-not (Assert-PrivateRoute $after $endpoint $proxyTarget $Port)) { throw 'Die private Serve-Route wurde nicht bestaetigt.' }
    Assert-ServiceUnchanged $cli $serviceProcess.Id $started $target
    Write-Host "Original OpenCode $version (PID $($serviceProcess.Id)): $url"
    Write-Host 'Private Tailscale-Route fuer OC fluffyTouch aktiv. Windows, OpenCode, Proxy und ggf. Voice-Bruecke muessen weiterlaufen.'
    if ($Pair) {
        Write-Host 'Einmal-Link jetzt in Safari auf dem iPhone oeffnen. Nicht speichern oder weitergeben.'
        # Stream directly to the terminal; do not persist or capture the pairing link.
        & $cli pair --url $url
        if ($LASTEXITCODE -ne 0) { throw "Native Paarung fehlgeschlagen (Exitcode $LASTEXITCODE)." }
    }
    else {
        Write-Host 'Fuer ein neues Geraet erneut mit -Pair ausfuehren.'
    }
}
catch {
    if (-not $readyForRoute) {
        foreach ($created in @($proxyProcess,$voiceProcess)) {
            if ($created) { try { if (-not $created.HasExited) { $created.Kill(); $null = $created.WaitForExit(2000) } } catch { } }
        }
    }
    Write-Error "OpenCode Touch: $($_.Exception.Message)" -ErrorAction Continue
    exit 1
}
finally { $env:OC_FLUFFYTOUCH_BRIDGE_TOKEN = $priorBridgeToken }
