<div align="center">

<img src="assets/readme/hero.png" alt="Illustration eines Schilds, das Werbung, Tracker, Cookies und andere unerwünschte Webanfragen filtert, bevor Chromium-Seiten geladen werden" width="1100">

<sub>Konzeptillustration · v1.0.0 ist eine manuell zu aktualisierende Sideload-Vorabversion</sub>

# uBlock Plus+

### Community-gestützte Inhaltsblockierung für Chromium Manifest V3

**Sideload-first · Local-first · Open Source · Für die Kontrolle durch die Nutzer**

[![MV3 Chromium CI](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml/badge.svg)](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml)
[![Neueste Version](https://img.shields.io/github/v/release/kayurachann/uBlock-Plus?include_prereleases&label=Vorabversion&color=3b82f6)](https://github.com/kayurachann/uBlock-Plus/releases)
[![Chromium 130+](https://img.shields.io/badge/Chromium-130%2B-4285F4?logo=googlechrome&logoColor=white)](#quick-start)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-8b5cf6)](ARCHITECTURE.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/Lizenz-GPL--3.0--or--later-22c55e)](../LICENSE.txt)

[English](../README.md) · [**Deutsch**](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [简体中文](README.zh_CN.md) · [繁體中文](README.zh_TW.md)

[**Neueste Vorschau herunterladen**](https://github.com/kayurachann/uBlock-Plus/releases) · [Funktionsmatrix](FEATURE-MATRIX.md) · [Architektur](ARCHITECTURE.md) · [Filter Store](FILTER-STORE.md) · [Roadmap](ROADMAP.md)

</div>

---

uBlock Plus+ ist ein unabhängiger, GPL-lizenzierter Inhaltsblocker für Chromium MV3. Er verbindet eine bewährte Filter- und Compiler-Grundlage des Upstreamprojekts mit einem Community Filter Store, portabler Konfiguration, ausdrücklichen Bedienelementen für erfahrene Nutzer und speicherbewusstem Betrieb – ohne Telemetriedienst des Projekts und ohne extern geladenen ausführbaren Code.

> [!IMPORTANT]
> **Veröffentlichungsstatus:** v1.0.0 ist eine Vorabversion zum manuellen Sideloading und wird nicht automatisch aktualisiert. uBlock Plus+ ist keine offizielle Veröffentlichung von uBlock Origin oder uBO Lite und wird nicht von Raymond Hill unterstützt. Chrome MV3 stellt nicht alle Blockierungsmechanismen der ursprünglichen MV2-Erweiterung bereit. Sideloading umgeht die Vertriebsrichtlinien des Chrome Web Store, hebt aber **weder** DNR-Kontingente noch Lebenszyklusregeln für Service Worker oder Sicherheitsgrenzen des Browsers auf. Siehe die [ehrliche Kompatibilitätsmatrix](FEATURE-MATRIX.md).

## Auf Ihre Entscheidungen ausgelegt

<table>
<tr>
<td width="50%" valign="top">

### 🛡️ Mehrschichtige Inhaltsblockierung

Statische, dynamische und sitzungsbezogene DNR-Regeln arbeiten mit kosmetischer Filterung, mitgelieferten Scriptlets, Strict Blocking und einem kontextabhängigen Smart Popup Blocker zusammen.

</td>
<td width="50%" valign="top">

### 🧩 Community Filter Store

Durchsuchen Sie den mitgelieferten Community-Katalog oder fügen Sie bis zu acht kompatible HTTPS-Repositories hinzu. Jede externe Liste wird als Filter-**Daten** behandelt, niemals als ausführbarer Erweiterungscode.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 Kontrolle für jede Website

Wählen Sie Filtermodi pro Website, prüfen Sie Diagnosedaten zu passenden Regeln und verwenden Sie Element Picker, Zapper oder Unpicker, wenn eine Seite eine persönliche Anpassung benötigt.

</td>
<td width="50%" valign="top">

### 🌱 Speicherbewusste Profile

Wählen Sie `auto`, `balanced` oder `low-memory`. Der Low-Memory-Modus verwendet sequenzielle Kompilierung, begrenzte Caches und sichere Bereinigung, ohne aktivierte Filter unbemerkt abzuschalten.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📦 Ihre Konfiguration, portabel

Exportieren und importieren Sie Kerneinstellungen, Abonnements, Repositories, Popup-Richtlinien und benutzerdefinierte Filter. Der integrierte Katalog ist ein Ausgangspunkt – kein Lock-in-Mechanismus.

</td>
<td width="50%" valign="top">

### 🔐 Datenschutz durch Design

Filterung und Speicherdiagnosen bleiben lokal. Es gibt weder ein Analysekonto des Projekts noch ein Werbe-SDK oder einen Dienst für den Browserverlauf; die Datenschutzsteuerung von Chrome erfordert eine separate, widerrufbare Berechtigung.

</td>
</tr>
</table>

Der vollständige Textsatz der Power-Oberfläche ist ins Englische, Deutsche, Spanische, Französische, Japanische, Koreanische, Russische, Vietnamesische sowie vereinfachte und traditionelle Chinesische übersetzt. Die anderen 61 mitgelieferten Locales erhalten beim Build einen deterministischen englischen Fallback, damit neue Bedienelemente nicht leer erscheinen, während die Community-Übersetzung noch aussteht.

<div align="center">

[Alle Funktionen entdecken →](FEATURE-MATRIX.md)

</div>

## In Aktion

<sub>Aufgenommen mit dem entpackten v1.0.0-Artefakt in einem frischen Edge-Profil · keine persönlichen Browserdaten</sub>

<table>
<tr>
<td width="62%" valign="top">

<img src="assets/readme/filter-store.png" alt="Der echte uBlock Plus+ Filter Store mit geschätztem DNR-Kontingent, drei Paketen und dem ersten Community-Filtereintrag">

<strong>Filter Store</strong><br>
Durchsuchen Sie Community-Einträge, prüfen Sie deren Einfluss auf das Kontingent und aktivieren Sie bewusst vorkonfigurierte Pakete.

</td>
<td width="38%" valign="top">

<img src="assets/readme/memory-settings.png" alt="Die echten Einstellungen des uBlock Plus+ Memory Profile mit Auto-Modus, Effective Balanced und lokalen Speicherdiagnosen">

<strong>Memory Profile</strong><br>
Wählen Sie Auto, Balanced oder Low-memory und prüfen Sie lokale Cache-/Speicherwerte – keine Messwerte des aktuellen Arbeitsspeichers.

</td>
</tr>
</table>

<a id="quick-start"></a>

## Schnellstart

<div align="center">

<img src="assets/readme/install-flow.svg" alt="Vier Schritte: herunterladen und entpacken, SHA-256 prüfen, entpackte Erweiterung laden und gegebenenfalls User Scripts zulassen" width="1100">

</div>

### Eine Veröffentlichung installieren

1. Laden Sie `uBlock-Plus_*.chromium.zip` und die dazugehörige `.sha256`-Datei von [GitHub Releases](https://github.com/kayurachann/uBlock-Plus/releases) herunter.
2. Prüfen Sie die Prüfsumme und entpacken Sie die ZIP-Datei anschließend in einen dauerhaften Ordner.
3. Öffnen Sie `chrome://extensions` oder `edge://extensions`.
4. Aktivieren Sie den **Entwicklermodus**, wählen Sie **Entpackte Erweiterung laden** und dann den entpackten Ordner mit der Datei `manifest.json`.
5. Öffnen Sie unter Chrome 138 oder neuer die Seite **Details** der Erweiterung und aktivieren Sie **User Scripts zulassen**. Chrome 130–137 verwendet stattdessen den globalen Schalter **Entwicklermodus**. Wenn Sie einen der Schalter nach der Installation ändern, klicken Sie auf der Erweiterungskarte auf **Neu laden**, damit der Service-Worker-Kontext den neuen API-Status erkennt. So können unterstützte importierte kosmetische Filter und mitgelieferte Scriptlets aus der Zulassungsliste registriert werden. Siehe die [`userScripts`-Anleitung von Chrome](https://developer.chrome.com/docs/extensions/reference/api/userScripts).

> [!NOTE]
> Eine per Sideloading installierte Erweiterung wird nicht über den Chrome Web Store aktualisiert. Folgen Sie den [Veröffentlichungen](https://github.com/kayurachann/uBlock-Plus/releases) und ersetzen Sie den entpackten Build, wenn eine neue Version erscheint. Installieren Sie ausschließlich Artefakte aus diesem Repository und prüfen Sie die mitgelieferte SHA-256-Prüfsumme.

<details>
<summary><strong>Prüfsumme der Veröffentlichung unter Windows prüfen</strong></summary>

```powershell
(Get-FileHash .\uBlock-Plus_1.0.0.chromium.zip -Algorithm SHA256).Hash
Get-Content .\uBlock-Plus_1.0.0.chromium.zip.sha256
```

Die hexadezimalen Hashwerte müssen übereinstimmen; die Groß-/Kleinschreibung spielt keine Rolle.

</details>

### Aus dem Quellcode bauen

Voraussetzungen: Chrome/Chromium oder Edge 130+, Git mit Submodulen, Node.js 22+ und Netzwerkzugriff für Filterdaten zur Build-Zeit.

<details open>
<summary><strong>Windows / PowerShell</strong></summary>

```powershell
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
.\tools\make-mv3.ps1 -Platform chromium -Version $version
```

</details>

<details>
<summary><strong>Linux / macOS</strong></summary>

```bash
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
make mv3-chromium

# Optional: zusätzlich die versionierte ZIP- und SHA-256-Datei erstellen.
VERSION=$(node -p "require('./package.json').version")
tools/make-mv3.sh chromium "$VERSION"
```

</details>

Laden Sie `dist/build/uBlockPlus.chromium` über die Erweiterungsseite des Browsers. Der versionierte PowerShell-Befehl und der optionale versionierte Shell-Befehl erzeugen ZIP-Datei und Prüfsumme unter `dist/build/`; ein einfaches `make mv3-chromium` erzeugt nur das entpackte Verzeichnis.

## So greifen die Komponenten ineinander

<div align="center">

<img src="assets/readme/feature-map.svg" alt="Filterablauf von den vom Nutzer gewählten Quellen über die geprüfte Kompilierung bis zu DNR und kosmetischer Filterung in Chromium" width="1100">

</div>

- Chrome DNR übernimmt die Netzwerkfilterung, ohne den Service Worker bei jeder Anfrage zu aktivieren.
- Der ereignisgesteuerte Service Worker verwaltet Einstellungen, Katalogstatus, Migrationen und wiederherstellbare Regelaktualisierungen.
- Importierte Listen werden lokal in DNR- und kosmetische Daten kompiliert; Scriptlets müssen bereits in der mitgelieferten Zulassungsliste enthalten sein.
- Die Offscreen-Kompilierung ist vorübergehend und wird nach Abschluss ihrer Arbeit beendet.

[Architektur lesen](ARCHITECTURE.md) · [Power Runtime erkunden](POWER-RUNTIME.md) · [Bedrohungsmodell prüfen](THREAT-MODEL.md) · [Datenschutz verstehen](PRIVACY.md) · [Community-Forschung lesen](COMMUNITY-RESEARCH.md)

## Sicherheits- und Vertrauensgrenzen

| Grenze | Projektregel |
| --- | --- |
| Externe Quellen | HTTPS-Kataloge und -Listen werden als größenbegrenzte Daten verarbeitet; Weiterleitungen, fehlerhafte Schemas und ausführbare Nutzdaten werden abgewiesen. |
| Vertrauen im Filter Store | Integrierte und benutzerdefinierte Einträge zeigen ihre Vertrauensstufe. Die Beliebtheit in der Community stuft einen Eintrag nie automatisch auf `verified` hoch. |
| Erweiterungscode | JavaScript, Scriptlets und Redirect-Ressourcen werden im geprüften Erweiterungspaket ausgeliefert – niemals von einer Laufzeit-URL. |
| Berechtigungen | Die Berechtigungen für die Kernfilterung sind dokumentiert. Die Chrome-Berechtigung `privacy` wird nur angefordert, wenn der Nutzer diese Steuerung aktiviert, und kann widerrufen werden. |
| Lokale Daten | Einstellungen, kompilierte Filter und Diagnosen zur Speichergröße bleiben auf dem Gerät, sofern der Nutzer sie nicht ausdrücklich exportiert. |
| Integrität der Veröffentlichung | Die CI baut und validiert das Chromium-Artefakt; Veröffentlichungen enthalten eine SHA-256-Prüfsumme. |

Sicherheitsprobleme sollten vertraulich über [GitHub Security Advisories](https://github.com/kayurachann/uBlock-Plus/security/advisories/new) und nicht in einem öffentlichen Issue gemeldet werden. Die Melderichtlinie finden Sie in [SECURITY.md](../SECURITY.md).

## MV3: leistungsfähig, mit ehrlichen Grenzen

| Heute verfügbar | Durch MV3 eingeschränkt | Zukünftige Forschung – optional |
| --- | --- | --- |
| DNR-Netzwerkblockierung, kosmetische Filterung, mitgelieferte Scriptlets, benutzerdefinierte/importierte Listen, Filter Store, Picker/Zapper, kontextabhängige Popup-Richtlinien pro Host, Observer-Durchsetzung für verpackte Stock-`$popup`-Regeln und den unterstützten Teil importierter `$popup`-/`$popunder`-Filter mit redigierter Herkunft aus Bereich/Quellzeile/Typ sowie Sichern/Wiederherstellen | Live-Protokollierung von Anfragen, prozedurale Filter, asynchrone Popup-Beobachtung, Semantik der dynamischen Firewall, Antwort-Header-Operationen und Redirect-Verhalten bieten keine exakte MV2-Parität | Verwaltete Enterprise-Adapter und ein unabhängig installiertes, quelloffenes natives Begleitprogramm, vorbehaltlich RFC, Zustimmung und Sicherheitsprüfung |

Der unterstützte Teil importierter Popup-Filter wird jetzt durch die Observer-Laufzeit durchgesetzt. Bedingungen, die nicht exakt abgebildet werden können—etwa Domain-Typ-, Request-Method- oder Response-Header-Bedingungen—bleiben ausdrücklich zurückgestellt, statt angenähert zu werden. Zurückgestellte Freigabebedingungen bleiben als konservative Fail-open-Schutzregeln erhalten; eine solche Schutzregel darf eine Entscheidung nur aufschieben und niemals näherungsweise erlauben oder blockieren. Da die Durchsetzung asynchronen Tab- und Navigationsereignissen von MV3 folgt, entspricht sie nicht exakt der synchronen MV2-Ausführung. Dynamische und sitzungsbezogene DNR-Regeln teilen sich einen einzigen Pool von 1.000 Regex-Regeln; sie erhalten nicht jeweils 1.000.

Beliebiges Umschreiben von Antwortinhalten, eine gleichwertige DNS-/CNAME-Sichtbarkeit und exaktes Blockieren anhand der Antwortgröße sind über die normalen öffentlichen MV3-Erweiterungs-APIs nicht verfügbar. Manche MV2-Filtersyntax kann nicht übersetzt werden; prüfen Sie die Funktionsmatrix, bevor Sie Gleichwertigkeit voraussetzen. Popup-Treffer legen lokal nur redigierte Herkunftsdaten zu Bereich, Quellzeile und Typ offen. Die Kompilierung importierter Netzwerklisten protokolliert stabile Annahme- oder Zurückstellungsgründe und Quellzeilennummern; eine ausführlichere Darstellung dieses Berichts im Dashboard bleibt Teil der Roadmap.

## Roadmap

<table>
<tr>
<th width="33%">Jetzt</th>
<th width="33%">Als Nächstes</th>
<th width="33%">Später</th>
</tr>
<tr>
<td valign="top">

- Power Edition härten
- Abläufe des Filter Store validieren
- Neustart- und Rollback-Pfade erproben
- Low-Memory-Basiswerte ermitteln

</td>
<td valign="top">

- Sichere Deduplizierung und Aufteilung von Regeln
- Ausführlichere lokale Diagnosen
- Barrierefreiheit und i18n verbessern
- Öffentliche Berichte zu Leistungsregressionen

</td>
<td valign="top">

- Verwalteter Enterprise-Adapter
- Optionale Forschung zu einem nativen Begleitprogramm
- Signierte Katalogherkunft und Widerruf

</td>
</tr>
</table>

Roadmap-Punkte sind keine Veröffentlichungszusagen. Eine Funktion wird erst ausgeliefert, nachdem Implementierung, Tests, Migration/Rollback sowie Sicherheits-, Datenschutz-, Lizenz- und Leistungsprüfung abgeschlossen sind. [Vollständige Community-Roadmap ansehen →](ROADMAP.md)

## Entwickeln und beitragen

```bash
npm ci
npm run lint
npm test
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

Ideen und Berichte sind über die strukturierten Issue-Formulare des Repositorys willkommen:

- [Eine Funktion vorschlagen oder einen Fehler melden](https://github.com/kayurachann/uBlock-Plus/issues/new/choose)
- [Einen Eintrag für den Filter Store einreichen](https://github.com/kayurachann/uBlock-Plus/issues/new?template=filter_store_submission.yml)
- [Leitfaden für Beiträge lesen](../CONTRIBUTING.md)
- [Community-Governance verstehen](COMMUNITY-GOVERNANCE.md)
- [Modulzuständigkeiten und -grenzen prüfen](MODULE-PLAN.md)

Das Repository bewahrt die Git-Historie des Upstreamprojekts und hält [`gorhill/uBlock`](https://github.com/gorhill/uBlock) als reinen Fetch-Remote namens `upstream` konfiguriert.

## Danksagung und Lizenz

uBlock Plus+ ist ein abgeleitetes Werk auf Grundlage von [uBlock Origin](https://github.com/gorhill/uBlock) und dessen MV3-/uBO-Lite-Implementierung. Urheberrechtsvermerke, Quelltext-Header, Autorenhistorie und Drittanbieterhinweise bleiben erhalten. Siehe [NOTICE.md](../NOTICE.md).

Veröffentlicht unter der [GNU General Public License Version 3.0 oder neuer](../LICENSE.txt).

<div align="center">

**Offen entwickelt, von seinen Nutzern mitgestaltet.**

[Zurück nach oben ↑](#ublock-plus)

</div>
