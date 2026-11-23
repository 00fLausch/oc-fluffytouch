# Installation

Führe die Befehle aus dem entpackten Projektordner in Windows PowerShell 5.1 oder neuer aus. Für Standalone brauchst du einen lokalen Windows-Rechner; für OpenCode zusätzlich laufendes OpenCode V2 Desktop, Node.js ab 22.13 und Tailscale auf PC und iPhone. Die Audio-Module brauchen **Python 3.11 oder neuer**; für eine frische Einrichtung ist 3.11 der getestete Ausgangspunkt. Der Installer braucht keine globale Python-Paketinstallation.

## Was der Installer prüft

1. **Ziel und Module wählen.** Gib die Nummern der Funktionen getrennt durch Kommas ein. Erforderliche Module werden ergänzt und vor einer Änderung aufgelistet. Beispiel: Live benötigt Transkript und Vorlesen; Auto-Voice benötigt nur Vorlesen.
2. **Vorhandenes erkennen.** Das Setup prüft für die gewählte Kombination auf Python und tatsächlich importierbare Pakete, auf die vier Parakeet-Dateien und bei Bedarf auf den lokalen OmniVoice-HTTP-Endpunkt. Im OpenCode-Modus kommen Node.js, der laufende Desktop-Prozess und der Tailscale-Status dazu. Das Skript prüft die Voice-Erinnerungen zusätzlich auf ihren Tokenzähler.
3. **Fehlendes einrichten.** Python-Pakete installiert das Setup in `.venv` im Projekt; `js-tiktoken` nur für Voice-Erinnerungen. Ein fehlendes Parakeet-Modell kann es nach Zustimmung aus der offiziellen Quelle laden. Python entpackt daraus die vier benötigten Dateien, ohne `tar.exe`. Fehlende Systemprogramme, OpenCode, Tailscale-Anmeldung und den separaten OmniVoice-Dienst richtest du mit der jeweils ausgegebenen Anleitung ein. Eine bestehende Installation oder fremde virtuelle Umgebung wird nicht umgeschrieben.
4. **Auswahl speichern.** `fluffytouch.local.json` enthält die aktivierten Module und lokalen Pfade. Gleiche Auswahl und Voraussetzungen erfordern beim nächsten Lauf keinen erneuten Download. Kein OpenCode-Dienst und keine Freigabe werden beim Installieren gestartet.
5. **Startanweisung ausführen.** Der Starter liest diese Auswahl und startet nur die passenden Projektkomponenten. Beim iPhone-Start prüft er zusätzlich Dienst, native API, HTML, freien Port und private Serve-Route. Eine fremde Route oder ein Funnel auf dem gewählten Port führt zum Abbruch, nicht zu einer Umstellung.

`-Check` prüft ohne Schreiben, Installation, Download oder Start. Ein Exitcode `2` steht für fehlende Komponenten oder nötige Handarbeit. `-VoicePython` und `-ModelDir` erlauben vorhandene kompatible Umgebungen und Modelle; der Pfad zu einer mit `-VoicePython` ausdrücklich gewählten Umgebung wird nur geprüft. `-Yes` bestätigt Paketinstallation und Konfiguration, aber einen fehlenden Modell-Download im automatisierten Lauf erst zusammen mit `-DownloadModel`.

## Nur Transkript

```powershell
.\Install-OCFluffyTouch.ps1 -Check -Mode Standalone -Features transcript
.\Install-OCFluffyTouch.ps1 -Mode Standalone -Features transcript
.\Start-OCFluffyTouch.ps1
```

Die API hört standardmäßig auf `http://127.0.0.1:14974`. Mit Strg+C beendest du sie. Bei einem belegten Port kannst du mit `-VoicePort` einen anderen wählen. [Ein WAV- und ein Streaming-Beispiel](voice-transcript.md) zeigen, wie deine App Text erhält.

## Diktat im bestehenden OpenCode-Chat

1. OpenCode Desktop öffnen und Windows wach lassen. Tailscale auf dem PC und iPhone im selben privaten Tailnet anmelden. HTTPS und Zugriffsregeln müssen den privaten Zugriff erlauben.
2. `.\Install-OCFluffyTouch.ps1 -Mode OpenCode -Features transcript` ausführen. Damit erscheint das Mikrofon am nativen Eingabefeld, ohne Live-Agent oder Vorlesen. Für andere Kombinationen den Installer interaktiv erneut öffnen.
3. `.\Start-OCFluffyTouch.ps1 -Pair` ausführen. Das Skript verwendet standardmäßig HTTPS-Port `8443`, Proxy `14973`, Voice `14974`. `-Port`, `-ProxyPort` und `-VoicePort` erlauben andere freie Ports. Es richtet nur die ausgewählte private Serve-Route ein; kein Funnel, kein Reset.
4. Den von OpenCode ausgegebenen Einmal-Link direkt in Safari auf dem iPhone öffnen. Nicht speichern, in eine Datei oder Transkription umleiten oder teilen. Bei Ablauf erneut mit `-Pair` starten.
5. Optional über **Teilen → Zum Home-Bildschirm** hinzufügen. Wenn iOS dort erneut eine Anmeldung verlangt, einen neuen Einmal-Link verwenden.

Ohne `-Pair` startet der Starter die gewählte Kombination ohne neuen Einmal-Link. Nach einem Windows-Neustart erst OpenCode öffnen, dann den Starter ausführen. Bei einem Wechsel von der älteren ZIP oder einer anderen Modulwahl die zugehörigen fluffyTouch-Prozesse neu starten und die iPhone-Web-App neu laden. Bei „andere Konfiguration“ oder „gehören nicht als Paar zusammen“ die Prozesse am **gewählten** Proxy-/Voice-Port prüfen. Beende nur eindeutig identifizierte Prozesse dieser Paketinstallation. OpenCode und eine andere private Installation bleiben dabei unberührt.

## Beratungsmodell wählen

Wenn du `expert` auswählst, fragt der Installer nach `Anbieter/Modell-ID`; im nicht interaktiven Lauf gibst du `-ExpertModel 'Anbieter/Modell-ID'` an. Verwende die exakte Referenz aus der Modellliste von OpenCode. Bei „Frag das große Modell“ prüft die App dieses Modell. Sie wechselt weder das Hauptchatmodell noch startet sie einen Auftrag. Ohne passende Auswahl gibt es keine automatische Ersatzwahl.

## Wenn etwas fehlt

| Meldung | Nächster Schritt |
| --- | --- |
| Python oder Node fehlt | Die im Installer angegebene Herstellerseite verwenden; danach neues PowerShell-Fenster öffnen und Prüfung wiederholen. |
| Modell fehlt oder lädt nicht | [Voice Transcript](voice-transcript.md) prüfen. Alle vier INT8-Dateien müssen im selben Ordner liegen. Ein Datei-Fund ist noch kein erfolgreicher Sprachtest. |
| OmniVoice fehlt | [Kompatibilitätsanleitung](omnivoice.md) lesen oder Vorlesen und davon abhängige Module abwählen. |
| Keine Sitzung oder kein Mikrofon in Safari | Tailscale-Verbindung und native Paarung prüfen, Mikrofonfreigabe beim Antippen zulassen. Home-Bildschirm-App schließen und erneut öffnen. |
| Route bereits belegt | Anderen privaten HTTPS-Port wählen. Den fremden Eintrag nicht löschen. |
| OpenCode nach Update nicht kompatibel | Starter-Ausgabe und [Entwicklungsanleitung](entwicklung.md) prüfen. Browser-Erweiterung und Service-Worker hängen von Aufbau und Version der originalen Oberfläche ab. |
