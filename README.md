# OC fluffyTouch

Quellvorschau 0.2.1 für Windows.

OC fluffyTouch ergänzt die bestehende OpenCode-Sitzung auf dem iPhone: diktieren, Antworten anhören, Ideen im Live-Gespräch klären und erst dann einen konkreten Auftrag an den Coding-Chat geben. Die OpenCode-Weboberfläche bleibt erhalten. Ein lokaler Proxy ergänzt sie über eine private Tailscale-Verbindung. OC fluffyTouch ist kein OpenCode-Plugin und startet keine zweite OpenCode-Instanz.

**Nur Sprache in Text umwandeln?** Voice Transcript läuft auch ohne OpenCode. Es stellt eine lokale API für WAV-Dateien und einen WebSocket für laufende Aufnahmen bereit. Dafür sind weder Tailscale noch OmniVoice, Node.js oder ein Chatmodell nötig. [So integrierst du Voice Transcript](docs/voice-transcript.md).

## Installation unter Windows

ZIP in einen beschreibbaren Ordner entpacken, PowerShell in diesem Ordner öffnen und ausführen:

```powershell
.\Install-OCFluffyTouch.ps1
```

Der Installer fragt zuerst nach dem Ziel (**Standalone** oder **OpenCode**) und danach nach den einzelnen Funktionen. Er zeigt mit an, welche Module dafür erforderlich sind. Er verwendet passende vorhandene Komponenten, installiert fehlende Projektpakete nach Rückfrage und nennt die Schritte für fehlende externe Dienste. Mit `-Check` prüft er nur. [Ablauf, Startbefehle und Fehlerhilfe](docs/installation.md).

| Funktion | Wofür? | Was sie zusätzlich braucht |
| --- | --- | --- |
| Voice Transcript | Diktat im Eingabefeld oder Transkript in einer eigenen App | Python, Parakeet INT8 auf der CPU |
| Vorlesen | Die komplette Antwort anhören, pausieren, fortsetzen oder stoppen | Python und separater, kompatibler OmniVoice-Dienst |
| Live-Gespräch | Fragen und Ideen zuerst mit dem Sprachassistenten klären | OpenCode-Integration, Transkript und Vorlesen |
| Auto-Voice | Nach Abschluss eine separate kurze Zusammenfassung hören | OpenCode-Integration und Vorlesen; kein Mikrofon |
| Coding-Übergabe | Einen geklärten Auftrag ausdrücklich an den Hauptchat geben | Live-Gespräch; [Rollenhinweis bei der ersten Übergabe](docs/module.md#rollenhinweis-in-opencode) |
| Sprachsteuerung | Stimme, Profil, Modell und Thinking per Sprache abfragen oder ändern | Live-Gespräch |
| Zweitmeinung | Beratung einholen, ohne den Coding-Chat zu starten | Live-Gespräch und eine in OpenCode verfügbare [Modellauswahl](docs/installation.md#beratungsmodell-wählen) |
| Voice-Erinnerungen | Bestätigte Vorlieben über Sitzungen hinweg im eigenen Profil behalten | Live-Gespräch, SQLite in Node.js und `js-tiktoken` |
| Verlaufslog | Uhrzeiten und bestätigte Schritte aus Hauptchat und Live vergleichen | OpenCode-Integration; Live ist optional |

Du kannst die mobile OpenCode-Oberfläche auch **ohne Sprachfunktionen** einrichten. Transkript und Vorlesen sind die beiden Bausteine, die sich auch außerhalb von OpenCode verwenden lassen. [Modulgrenzen und Datenflüsse](docs/module.md).

## Was in der ZIP steckt

- PowerShell-Installer und Starter, Modulbeschreibungen und Paketlisten.
- Python-Sprachbrücke, Node-Proxy, Browser-JavaScript und AudioWorklet für die originale Weboberfläche.
- Quellcode für Verlaufslog und Erinnerungen, Tests und ein minimales Python-Beispiel für die Transkript-API.
- [Separate Anleitung für OmniVoice](docs/omnivoice.md). OmniVoice selbst, Modellgewichte, private Stimmaufnahmen und Zugangsdaten sind nicht enthalten. Parakeet kommt bei Bedarf aus dem verlinkten Upstream-Release.

## Stand der Vorschau

Windows ist die Zielplattform des Installers. Für den iPhone-Modus muss ein kompatibles OpenCode V2 Desktop bereits laufen. OpenCode-Updates können die Weboberfläche oder experimentelle API ändern; es gibt keine pauschale Versionsfreigabe. Die [Prüfanleitung](docs/entwicklung.md) trennt Tests der Module von der Abnahme auf einem echten iPhone. Abhängigkeiten behalten ihre jeweiligen Lizenzen.

## Lizenz

Der Projektcode steht unter der [MIT-Lizenz](LICENSE). Abhängigkeiten wie sherpa-onnx, OmniVoice und OpenCode behalten ihre eigenen Lizenzen.
