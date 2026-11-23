#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Standalone','OpenCode')][string]$Mode,
    [string[]]$Features,
    [string]$VoicePython,
    [string]$ModelDir,
    [string]$OmniVoiceUrl,
    [string]$ExpertModel,
    [switch]$Check,
    [switch]$Yes,
    [switch]$DownloadModel
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'setup-common.ps1')

function Test-AudioPython([string]$Executable, [string[]]$Modules) {
    if (-not $Executable -or -not (Test-Path -LiteralPath $Executable -PathType Leaf)) { return $false }
    $imports = $Modules -join ', '
    $probe = Invoke-FluffyProbe $Executable @('-B','-c',"import sys; assert sys.version_info >= (3, 11); import $imports; print('ready')")
    return $probe.exitCode -eq 0 -and $probe.output -match '(?m)^ready\s*$'
}

function Find-Python {
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        foreach ($selector in '-3.11','-3') {
            $exe = Invoke-FluffyProbe $launcher.Source @($selector,'-B','-c','import sys; assert sys.version_info >= (3, 11); print(sys.executable)')
            if ($exe.exitCode -eq 0 -and $exe.output -and (Test-Path -LiteralPath $exe.output -PathType Leaf)) { return $exe.output }
        }
    }
    $command = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($command -and $command.Source -notmatch '[\\/]WindowsApps[\\/]') { return $command.Source }
    return $null
}

function Install-Parakeet {
    param([string]$ModelsRoot, [string]$Python)
    $destination = Join-Path $ModelsRoot $FluffyModelName
    if (Test-Path -LiteralPath $destination) { throw 'Der Zielordner ist bereits vorhanden, aber unvollstaendig. Gib mit -ModelDir einen vollstaendigen Ordner an.' }
    $drive = Get-PSDrive -Name (Get-Item -LiteralPath $PSScriptRoot).PSDrive.Name
    if ($drive.Free -and $drive.Free -lt 2GB) { throw 'Weniger als 2 GB Platz fuer Archiv, Entpacken und Modell.' }
    $null = New-Item -ItemType Directory -Path $ModelsRoot -Force
    $scratch = Join-Path $ModelsRoot ('.download-' + [guid]::NewGuid().ToString('N'))
    $null = New-Item -ItemType Directory -Path $scratch
    $archive = Join-Path $scratch 'parakeet.tar.bz2'
    $extracted = Join-Path $scratch $FluffyModelName
    try {
        Write-Host "Lade das Parakeet-Archiv von $FluffyModelUrl"
        Invoke-WebRequest -Uri $FluffyModelUrl -UseBasicParsing -OutFile $archive -TimeoutSec 900
        & $Python -B (Join-Path $PSScriptRoot 'extract-model.py') $archive $extracted
        if ($LASTEXITCODE -ne 0 -or -not (Test-FluffyModel $extracted)) {
            throw 'Modell konnte nicht vollstaendig entpackt werden. Die aktive Konfiguration bleibt unveraendert.'
        }
        [IO.Directory]::Move($extracted, $destination)
        return $destination
    } finally {
        [IO.File]::Delete($archive)
        if ([IO.Directory]::Exists($extracted)) {
            foreach ($file in $FluffyModelFiles) { [IO.File]::Delete((Join-Path $extracted $file)) }
            [IO.Directory]::Delete($extracted)
        }
        [IO.Directory]::Delete($scratch)
    }
}

try {
    $prior = if (Test-Path -LiteralPath $FluffyConfigPath -PathType Leaf) {
        Get-Content -LiteralPath $FluffyConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    Write-Host 'OC fluffyTouch | Einrichtung fuer Windows'
    if (-not $Mode) {
        if ($Check -or $Yes) { $Mode = (Get-FluffyProperty $prior 'mode'); if (-not $Mode) { $Mode = 'Standalone' } }
        else {
            Write-Host '1: Standalone (fuer deine App), 2: OpenCode auf dem iPhone'
            switch (Read-Host 'Ziel [1]') { '2' { $Mode='OpenCode' }; {$_ -in @('','1')} { $Mode='Standalone' }; default { throw 'Waehle 1 oder 2.' } }
        }
    }
    if (-not $PSBoundParameters.ContainsKey('Features')) {
        if ($Check -or $Yes) {
            $Features = if ((Get-FluffyProperty $prior 'mode') -eq $Mode) { $prior.features } else { 'transcript' }
        } else {
            $choices = @($FluffyCatalog.PSObject.Properties | Where-Object { $Mode -eq 'OpenCode' -or (Get-FluffyProperty $_.Value 'standalone') })
            for ($i=0; $i -lt $choices.Count; $i++) { Write-Host ('{0,2}: {1}' -f ($i+1), $choices[$i].Value.label) }
            if ($Mode -eq 'OpenCode') { Write-Host ' 0: Nur mobile OpenCode-Oberflaeche' }
            $raw = (Read-Host 'Nummern mit Komma trennen [1]').Trim()
            if (-not $raw) { $raw = '1' }
            if ($raw -eq '0' -and $Mode -eq 'OpenCode') { $Features = @() }
            else {
                $Features = @(foreach ($entry in $raw.Split(',')) {
                    $number = 0
                    if (-not [int]::TryParse($entry.Trim(), [ref]$number) -or $number -lt 1 -or $number -gt $choices.Count) { throw "Ungueltige Nummer: $entry" }
                    $choices[$number-1].Name
                })
            }
        }
    }
    $chosen = @(Resolve-FluffyFeatures $Mode $Features)
    Write-Host ('Aktiv: ' + $(if ($chosen.Count) { $chosen -join ', ' } else { 'nur mobile Oberflaeche' }))
    $asr = $chosen -contains 'transcript'
    $tts = $chosen -contains 'read-aloud'
    $audio = $asr -or $tts
    $blocked = [System.Collections.Generic.List[string]]::new()
    $modules = @('fastapi','numpy','uvicorn','websockets')
    $requirements = @('-r', (Join-Path $PSScriptRoot 'requirements-audio.txt'))
    if ($asr) { $modules += 'sherpa_onnx'; $requirements += @('-r', (Join-Path $PSScriptRoot 'requirements-asr.txt')) }
    if ($tts) { $modules += 'httpx'; $requirements += @('-r', (Join-Path $PSScriptRoot 'requirements-tts.txt')) }
    $venv = Join-Path $PSScriptRoot '.venv'
    $venvPython = Join-Path $venv 'Scripts\python.exe'
    $providedPython = $PSBoundParameters.ContainsKey('VoicePython')
    $readyPython = $false
    $pythonBase = $null
    if ($audio) {
        if (-not $VoicePython) { $VoicePython = (Get-FluffyProperty $prior 'python') }
        if (-not $VoicePython -or (-not $providedPython -and -not (Test-Path -LiteralPath $VoicePython))) { $VoicePython = $venvPython }
        $readyPython = Test-AudioPython $VoicePython $modules
        if ($readyPython) { Write-Host 'Python-Pakete: vorhanden, werden weiterverwendet.' }
        elseif ($providedPython) { $blocked.Add('Das angegebene Python muss mindestens 3.11 sein und alle benoetigten Pakete haben. Verwende eine passende Umgebung oder lasse -VoicePython weg.') }
        else {
            $VoicePython = $venvPython
            $pythonBase = if (Test-Path -LiteralPath $venvPython) { $venvPython } else { Find-Python }
            if (-not (Test-AudioPython $pythonBase @('venv'))) {
                if (Test-Path -LiteralPath $venvPython) { $blocked.Add('Die vorhandene .venv ist nicht kompatibel. Eine neue Umgebung mit Python 3.11+ angeben; die alte bleibt unveraendert.') }
                else { $blocked.Add('Python 3.11 oder neuer: https://www.python.org/downloads/windows/ . Danach Setup erneut oeffnen.') }
            }
            else { Write-Host 'Python-Pakete: fehlen; werden in der projektlokalen .venv installiert.' }
        }
    } else { $VoicePython = '' }

    if ($asr) {
        if ($ModelDir -and -not (Test-FluffyModel $ModelDir)) { $blocked.Add('-ModelDir enthaelt nicht alle vier benoetigten Dateien.') }
        if (-not $ModelDir) {
            $localModel = Join-Path $PSScriptRoot "models\$FluffyModelName"
            $ModelDir = @((Get-FluffyProperty $prior 'modelDir'), $env:OPENCODE_TOUCH_PARAKEET, $localModel) |
                Where-Object { Test-FluffyModel $_ } | Select-Object -First 1
        }
        if ($ModelDir -and (Test-FluffyModel $ModelDir)) { Write-Host 'Parakeet INT8: vier Modelldateien vorhanden, kein Download.' }
        elseif (-not $ModelDir) { Write-Host "Parakeet fehlt. Download separat nach Freigabe: $FluffyModelUrl" }
    } else { $ModelDir = '' }

    if ($tts) {
        if (-not $OmniVoiceUrl) { $OmniVoiceUrl = Get-FluffyProperty $prior 'omniVoiceUrl' }
        if (-not $OmniVoiceUrl) { $OmniVoiceUrl = 'http://127.0.0.1:7861' }
        $OmniVoiceUrl = Assert-FluffyOmniUrl $OmniVoiceUrl
        $known = $false
        try {
            $spec = Invoke-RestMethod -Uri "$OmniVoiceUrl/openapi.json" -TimeoutSec 3 -MaximumRedirection 0
            $known = [bool](Get-FluffyProperty (Get-FluffyProperty $spec 'paths') '/tts/stream' | ForEach-Object { Get-FluffyProperty $_ 'post' })
        } catch { }
        if (-not $known) {
            try { $null = Invoke-WebRequest -Uri "$OmniVoiceUrl/tts/stream" -Method Get -UseBasicParsing -TimeoutSec 3 -MaximumRedirection 0 }
            catch {
                $resp = Get-FluffyProperty $_.Exception 'Response'
                if ($resp -and [int]$resp.StatusCode -eq 405) { $known = [string]($resp.Headers['Allow']) -match '(?i)\bPOST\b' }
            }
        }
        if ($known) { Write-Host 'OmniVoice: lokaler POST-Endpunkt gefunden. Audio separat testen.' }
        else { $blocked.Add('Ein kompatibler OmniVoice-Dienst mit POST /tts/stream fehlt. Anleitung: docs/omnivoice.md. Oder ohne Vorlesen weiter.') }
    } else { $OmniVoiceUrl = '' }

    if ($chosen -contains 'expert') {
        if (-not $ExpertModel) { $ExpertModel = Get-FluffyProperty $prior 'expertModel' }
        if (-not $ExpertModel -and -not ($Check -or $Yes)) { $ExpertModel = Read-Host 'Beratungsmodell aus der OpenCode-Modellliste (Anbieter/Modell-ID)' }
        if ($ExpertModel) { $ExpertModel = Assert-FluffyExpertModel $ExpertModel }
        else { $blocked.Add('Fuer expert -ExpertModel Anbieter/Modell-ID angeben. Es wird kein Modell automatisch gewaehlt.') }
    } elseif ($ExpertModel) { throw '-ExpertModel braucht die Funktion expert.' }

    if ($chosen -contains 'handoff') {
        Write-Host 'Die erste ausdrueckliche Uebergabe setzt einen dauerhaften Rollenhinweis in der Sitzung. Entfernen: docs/module.md.'
    }

    $needTokenizer = $false
    if ($Mode -eq 'OpenCode') {
        $node = Get-Command node.exe -ErrorAction SilentlyContinue
        $nodeVersion = if ($node) { (Invoke-FluffyProbe $node.Source @('--no-warnings','-p','process.versions.node')).output }
        $nodeReady = $nodeVersion -match '^\d+\.\d+\.\d+$' -and [version]$nodeVersion -ge [version]'22.13'
        if (-not $nodeReady) { $blocked.Add('Node.js 22.13+ fehlt: https://nodejs.org/en/download') }
        else { Write-Host "Node.js ${nodeVersion}: vorhanden." }
        if ($nodeReady -and $chosen -contains 'memory') {
            $sqlite = Invoke-FluffyProbe $node.Source @('--no-warnings','-p',"typeof require('node:sqlite').DatabaseSync === 'function'")
            if ($sqlite.exitCode -ne 0 -or $sqlite.output -ne 'true') { $blocked.Add('Dieses Node.js stellt SQLite nicht bereit. Node.js 22.13+ mit node:sqlite verwenden.') }
            $found = Invoke-FluffyProbe $node.Source @('--no-warnings','-p',"require.resolve('js-tiktoken',{paths:[process.argv[1]]})",$PSScriptRoot)
            $needTokenizer = $found.exitCode -ne 0
            if ($needTokenizer -and -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { $blocked.Add('npm fehlt fuer den Tokenzaehler der Voice-Erinnerungen. Node.js inklusive npm installieren.') }
            if ($needTokenizer) { Write-Host 'Voice-Erinnerungen: installiere js-tiktoken lokal, falls die Einrichtung fortgesetzt wird.' }
        }
        $running = @(Get-Process -Name 'opencode-cli' -ErrorAction SilentlyContinue | Where-Object { $_.Path })
        if ($running.Count -ne 1) { $blocked.Add('Genau ein laufendes OpenCode V2 Desktop ist noetig: https://opencode.ai/download') }
        else { Write-Host 'OpenCode-Prozess gefunden. Der Starter verifiziert Dienst, API und Originaloberflaeche.' }
        $tailscale = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
        if (-not (Test-Path -LiteralPath $tailscale -PathType Leaf)) { $blocked.Add('Tailscale fehlt: https://tailscale.com/download . Auf PC und iPhone ins eigene Tailnet anmelden.') }
        else {
            $status = Invoke-FluffyProbe $tailscale @('status','--json')
            $state = if ($status.exitCode -eq 0 -and $status.output) { try { ($status.output | ConvertFrom-Json).BackendState } catch { $null } }
            if ($state -ne 'Running') { $blocked.Add('Tailscale ist nicht verbunden. Erst anmelden und erneut pruefen.') }
            else { Write-Host 'Tailscale verbunden. Keine Route wurde eingerichtet.' }
        }
    }
    if ($blocked.Count) { foreach ($reason in $blocked) { Write-Host "Manuell: $reason" }; exit 2 }
    if ($Check) {
        if (($audio -and -not $readyPython) -or ($asr -and -not $ModelDir) -or $needTokenizer) { Write-Host 'Pruefung: installierbare Bestandteile fehlen. -Check hat nichts installiert.'; exit 2 }
        Write-Host 'Pruefung bestanden; keine Installation und kein Start.'; exit 0
    }
    if ($asr -and -not $ModelDir -and -not $DownloadModel) {
        if ($Yes -or (Read-Host 'Offizielles Modellarchiv holen (ca. 2 GB freier Platz)? [j/N]') -notmatch '^(j|ja|y|yes)$') {
            throw 'Kein Parakeet-Modell. -ModelDir oder -DownloadModel verwenden; siehe docs/voice-transcript.md.'
        }
        $DownloadModel = $true
    }
    if (-not $Yes -and (Read-Host 'Auswahl installieren bzw. speichern? [j/N]') -notmatch '^(j|ja|y|yes)$') { Write-Host 'Abgebrochen. Nichts installiert.'; exit 0 }
    if ($audio -and -not $readyPython) {
        if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
            & $pythonBase -m venv $venv
            if ($LASTEXITCODE -ne 0) { throw 'Virtuelle Python-Umgebung konnte nicht angelegt werden.' }
        }
        & $venvPython -m pip install --disable-pip-version-check @requirements
        if ($LASTEXITCODE -ne 0 -or -not (Test-AudioPython $venvPython $modules)) { throw 'Python-Pakete konnten nicht geladen werden.' }
        $VoicePython = $venvPython
    }
    if ($asr -and -not $ModelDir -and $DownloadModel) { $ModelDir = Install-Parakeet (Join-Path $PSScriptRoot 'models') $VoicePython }
    if ($asr) {
        $ModelDir = (Resolve-Path -LiteralPath $ModelDir).Path
        $env:OPENCODE_TOUCH_PARAKEET = $ModelDir
        $result = & $VoicePython -B (Join-Path $PSScriptRoot 'voice-bridge.py') --self-test
        if ($LASTEXITCODE -ne 0 -or -not ($result | ConvertFrom-Json).model_available) { throw 'Sprachbruecke findet das Modell nicht.' }
        Write-Host 'Audio-Selbsttest und Modelldateien geprueft. Echte Transkription siehe Anleitung.'
    }
    if ($needTokenizer) {
        & npm.cmd --prefix $PSScriptRoot install --ignore-scripts --no-audit --no-fund --include=optional
        if ($LASTEXITCODE -ne 0) { throw 'npm konnte den Tokenzaehler nicht installieren.' }
        $installed = Invoke-FluffyProbe $node.Source @('--no-warnings','-p',"require.resolve('js-tiktoken',{paths:[process.argv[1]]})",$PSScriptRoot)
        if ($installed.exitCode -ne 0) { throw 'Tokenzaehler fehlt trotz npm-Installation.' }
    }
    if ($audio) { $VoicePython = (Resolve-Path -LiteralPath $VoicePython).Path }
    $new = [ordered]@{ schema=1; mode=$Mode; features=@($chosen); python=$VoicePython; modelDir=$ModelDir; omniVoiceUrl=$OmniVoiceUrl; expertModel=$ExpertModel } | ConvertTo-Json
    $old = if (Test-Path -LiteralPath $FluffyConfigPath -PathType Leaf) { Get-Content -LiteralPath $FluffyConfigPath -Raw -Encoding UTF8 } else { '' }
    if ($new.Trim() -cne $old.Trim()) {
        $staged = "$FluffyConfigPath.$([guid]::NewGuid().ToString('N')).tmp"
        Set-Content -LiteralPath $staged -Value $new -Encoding UTF8
        Move-Item -LiteralPath $staged -Destination $FluffyConfigPath -Force
    }
    Write-Host 'Auswahl gespeichert. Kein Dienst und keine Freigabe automatisch gestartet.'
    if ($Mode -eq 'OpenCode') { Write-Host 'Naechster Schritt: .\Start-OCFluffyTouch.ps1 -Pair ; dann Einmal-Link in Safari oeffnen.' }
    else { Write-Host 'Naechster Schritt: .\Start-OCFluffyTouch.ps1 ; dann localhost-API pruefen (siehe docs/voice-transcript.md bzw. docs/omnivoice.md).' }
} catch {
    Write-Host "Setup angehalten: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
