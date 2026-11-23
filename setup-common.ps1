$FluffyConfigPath = Join-Path $PSScriptRoot 'fluffytouch.local.json'
$FluffyCatalog = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'features.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$FluffyModelName = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'
$FluffyModelUrl = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$FluffyModelName.tar.bz2"
$FluffyModelFiles = @('encoder.int8.onnx','decoder.int8.onnx','joiner.int8.onnx','tokens.txt')

function Invoke-FluffyProbe([string]$Executable, [string[]]$Arguments) {
    # Windows PowerShell 5.1 promotes redirected stderr to an ErrorRecord.
    $ErrorActionPreference = 'Continue'
    $output = & $Executable @Arguments 2>$null
    [pscustomobject]@{ exitCode = $LASTEXITCODE; output = (@($output) -join "`n").Trim() }
}

function Get-FluffyProperty($Object, [string]$Name) {
    if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) { $Object.PSObject.Properties[$Name].Value }
}

function Resolve-FluffyFeatures([string]$Mode, [string[]]$Features) {
    $result = [System.Collections.Generic.List[string]]::new()
    function Add-Feature([string]$Name) {
        $Name = $Name.Trim().ToLowerInvariant()
        $item = Get-FluffyProperty $FluffyCatalog $Name
        if (-not $item) { throw "Unbekannte Funktion: $Name" }
        if ($Mode -eq 'Standalone' -and -not (Get-FluffyProperty $item 'standalone')) {
            throw "$Name braucht die OpenCode-Einbindung."
        }
        foreach ($need in $item.requires) { Add-Feature $need }
        if (-not $result.Contains($Name)) { $result.Add($Name) }
    }
    foreach ($name in $Features) { Add-Feature $name }
    if ($Mode -eq 'Standalone' -and $result.Count -eq 0) { throw 'Waehle mindestens eine Standalone-Funktion.' }
    $result.ToArray()
}

function Test-FluffyModel([string]$Directory) {
    if (-not $Directory -or -not (Test-Path -LiteralPath $Directory -PathType Container)) { return $false }
    foreach ($file in $FluffyModelFiles) {
        $item = Get-Item -LiteralPath (Join-Path $Directory $file) -ErrorAction SilentlyContinue
        if (-not $item -or $item.PSIsContainer -or $item.Length -le 0) { return $false }
    }
    return $true
}

function Assert-FluffyOmniUrl([string]$Base) {
    $u = $null
    if (-not [Uri]::TryCreate($Base, [UriKind]::Absolute, [ref]$u) -or $u.Scheme -ne 'http' -or
        $u.Host -ne '127.0.0.1' -or $u.UserInfo -or $u.Query -or $u.Fragment -or $u.AbsolutePath -ne '/') {
        throw 'OmniVoice muss eine lokale HTTP-Adresse wie http://127.0.0.1:7861 sein.'
    }
    $u.GetLeftPart([UriPartial]::Authority)
}

function Assert-FluffyExpertModel([string]$Model) {
    $Model = $Model.Trim()
    if ($Model -notmatch '\A[a-z0-9_.-]+/[a-z0-9_.:+@/-]+\z') {
        throw 'Beratungsmodell als Anbieter/Modell-ID angeben (siehe Modellliste in OpenCode).'
    }
    $Model
}
