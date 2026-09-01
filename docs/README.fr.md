<div align="center">

<img src="assets/readme/hero.png" alt="Illustration d'un bouclier filtrant les publicités, les traqueurs, les cookies et d'autres requêtes web indésirables avant le chargement des pages Chromium" width="1100">

<sub>Illustration conceptuelle · v1.0.0 est une préversion installée et mise à jour manuellement</sub>

# uBlock Plus+

### Blocage de contenu porté par la communauté, conçu pour Chromium Manifest V3

**Sideload-first · Local-first · Open source · Conçu pour vous laisser le contrôle**

[![MV3 Chromium CI](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml/badge.svg)](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml)
[![Dernière version](https://img.shields.io/github/v/release/kayurachann/uBlock-Plus?include_prereleases&label=pre--release&color=3b82f6)](https://github.com/kayurachann/uBlock-Plus/releases)
[![Chromium 130+](https://img.shields.io/badge/Chromium-130%2B-4285F4?logo=googlechrome&logoColor=white)](#quick-start)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-8b5cf6)](ARCHITECTURE.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/licence-GPL--3.0--or--later-22c55e)](../LICENSE.txt)

[English](../README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [**Français**](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [简体中文](README.zh_CN.md) · [繁體中文](README.zh_TW.md)

[**Télécharger la dernière préversion**](https://github.com/kayurachann/uBlock-Plus/releases) · [Matrice des fonctionnalités](FEATURE-MATRIX.md) · [Architecture](ARCHITECTURE.md) · [Filter Store](FILTER-STORE.md) · [Feuille de route](ROADMAP.md)

</div>

---

uBlock Plus+ est un bloqueur de contenu indépendant pour Chromium MV3, distribué sous licence GPL. Il associe une base éprouvée de filtrage et de compilation issue du projet d'origine à un Filter Store communautaire, une configuration portable, des commandes explicites pour les utilisateurs avancés et un fonctionnement attentif à la mémoire, sans service de télémétrie du projet ni code exécutable distant.

> [!IMPORTANT]
> **État de la version :** v1.0.0 est une préversion destinée à l'installation manuelle et ne se met pas à jour automatiquement. uBlock Plus+ n'est pas une version officielle d'uBlock Origin ou d'uBO Lite et n'est pas approuvé par Raymond Hill. Chrome MV3 n'expose pas tous les mécanismes de blocage disponibles dans l'extension MV2 d'origine. L'installation manuelle évite la politique de distribution du Chrome Web Store, mais ne supprime **ni** les quotas DNR, ni les règles de cycle de vie des service workers, ni les limites de sécurité du navigateur. Consultez la [matrice de compatibilité transparente](FEATURE-MATRIX.md).

## Conçu autour de vos choix

<table>
<tr>
<td width="50%" valign="top">

### 🛡️ Blocage de contenu multicouche

Les règles DNR statiques, dynamiques et de session fonctionnent avec le filtrage cosmétique, les scriptlets intégrés, le blocage strict et un Smart Popup Blocker sensible au contexte.

</td>
<td width="50%" valign="top">

### 🧩 Filter Store communautaire

Parcourez le catalogue communautaire intégré ou ajoutez jusqu'à huit dépôts HTTPS compatibles. Chaque liste distante est traitée comme une **donnée** de filtrage, jamais comme du code exécutable de l'extension.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 Des commandes pour chaque site

Choisissez le mode de filtrage de chaque site, consultez le diagnostic des règles correspondantes et utilisez le sélecteur d'éléments, le zapper ou l'unpicker lorsqu'une page demande un ajustement personnel.

</td>
<td width="50%" valign="top">

### 🌱 Profils attentifs à la mémoire

Choisissez `auto`, `balanced` ou `low-memory`. Le mode Low-memory utilise une compilation séquentielle, des caches limités et un nettoyage sûr, sans désactiver silencieusement les filtres activés.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📦 Votre configuration, partout avec vous

Exportez et restaurez les paramètres principaux, les abonnements, les dépôts, les politiques de fenêtres contextuelles et les filtres personnalisés. Le catalogue intégré est un point de départ, pas un mécanisme d'enfermement.

</td>
<td width="50%" valign="top">

### 🔐 Confidentialité dès la conception

Le filtrage et les diagnostics de stockage restent locaux. Le projet n'utilise ni compte d'analyse, ni SDK publicitaire, ni service d'historique de navigation ; les contrôles de confidentialité de Chrome nécessitent une autorisation distincte et révocable.

</td>
</tr>
</table>

L'ensemble complet des textes de l'interface Power est traduit en anglais, allemand, espagnol, français, japonais, coréen, russe, vietnamien, chinois simplifié et chinois traditionnel. Les 61 autres paramètres régionaux inclus reçoivent lors de la compilation un fallback anglais déterministe, afin qu'aucune nouvelle commande ne soit vide pendant que la traduction communautaire progresse.

<div align="center">

[Découvrir toutes les fonctionnalités →](FEATURE-MATRIX.md)

</div>

## Voir l'extension en action

<sub>Capture réalisée avec l'artefact v1.0.0 décompressé dans un nouveau profil Edge · aucune donnée de navigation personnelle</sub>

<table>
<tr>
<td width="62%" valign="top">

<img src="assets/readme/filter-store.png" alt="Le véritable Filter Store d'uBlock Plus+ affichant les estimations de quota DNR, trois lots et la première fiche de filtre communautaire">

<strong>Filter Store</strong><br>
Parcourez les entrées communautaires, examinez leur impact sur les quotas et activez explicitement des lots préconfigurés.

</td>
<td width="38%" valign="top">

<img src="assets/readme/memory-settings.png" alt="Les véritables paramètres Memory Profile d'uBlock Plus+ affichant le mode Auto, Effective Balanced et les diagnostics de stockage local">

<strong>Memory Profile</strong><br>
Sélectionnez Auto, Balanced ou Low-memory et consultez les mesures locales de cache et de stockage, pas la mémoire vive en temps réel.

</td>
</tr>
</table>

<a id="quick-start"></a>

## Démarrage rapide

<div align="center">

<img src="assets/readme/install-flow.svg" alt="Quatre étapes : télécharger et extraire, vérifier SHA-256, charger l'extension non empaquetée, puis autoriser User Scripts si l'option apparaît" width="1100">

</div>

### Installer une version

1. Téléchargez `uBlock-Plus_*.chromium.zip` et le fichier `.sha256` correspondant depuis les [versions GitHub](https://github.com/kayurachann/uBlock-Plus/releases).
2. Vérifiez la somme de contrôle, puis extrayez l'archive ZIP dans un dossier permanent.
3. Ouvrez `chrome://extensions` ou `edge://extensions`.
4. Activez le **Mode développeur**, choisissez **Charger l'extension non empaquetée**, puis sélectionnez le dossier extrait qui contient `manifest.json`.
5. Sous Chrome 138 ou une version ultérieure, ouvrez la page **Détails** de l'extension et activez **Autoriser les User Scripts**. Chrome 130–137 utilise à la place le commutateur global **Mode développeur**. Si vous modifiez l'un de ces commutateurs après l'installation, cliquez sur **Actualiser** sur la fiche de l'extension afin que le contexte du service worker reconnaisse le nouvel état de l'API. Les filtres cosmétiques importés compatibles et les scriptlets intégrés à la liste d'autorisation peuvent ainsi s'enregistrer. Consultez les [instructions de Chrome sur `userScripts`](https://developer.chrome.com/docs/extensions/reference/api/userScripts).

> [!NOTE]
> Une extension installée manuellement n'est pas mise à jour par le Chrome Web Store. Suivez les [versions publiées](https://github.com/kayurachann/uBlock-Plus/releases) et remplacez la compilation décompressée lorsqu'une nouvelle version paraît. N'installez que les artefacts de ce dépôt et vérifiez la somme de contrôle SHA-256 fournie.

<details>
<summary><strong>Vérifier la somme de contrôle de la version sous Windows</strong></summary>

```powershell
(Get-FileHash .\uBlock-Plus_1.0.0.chromium.zip -Algorithm SHA256).Hash
Get-Content .\uBlock-Plus_1.0.0.chromium.zip.sha256
```

Les empreintes hexadécimales doivent être identiques ; la casse n'a pas d'importance.

</details>

### Compiler depuis les sources

Prérequis : Chrome/Chromium ou Edge 130+, Git avec les sous-modules, Node.js 22+ et un accès réseau aux données de filtrage pendant la compilation.

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

# Facultatif : créer aussi le ZIP versionné et le fichier SHA-256.
VERSION=$(node -p "require('./package.json').version")
tools/make-mv3.sh chromium "$VERSION"
```

</details>

Chargez `dist/build/uBlockPlus.chromium` depuis la page des extensions du navigateur. La commande PowerShell versionnée et la commande shell versionnée facultative créent le ZIP et la somme de contrôle dans `dist/build/` ; la commande simple `make mv3-chromium` ne crée que le dossier décompressé.

## Fonctionnement de l'ensemble

<div align="center">

<img src="assets/readme/feature-map.svg" alt="Flux de filtrage depuis les sources choisies par l'utilisateur jusqu'à DNR et au filtrage cosmétique dans Chromium, en passant par une compilation vérifiée" width="1100">

</div>

- Chrome DNR assure le filtrage réseau sans réveiller le service worker à chaque requête.
- Le service worker piloté par les événements gère les paramètres, l'état du catalogue, les migrations et les mises à jour de règles récupérables.
- Les listes importées sont compilées localement en données DNR et cosmétiques ; les scriptlets doivent déjà figurer dans la liste d'autorisation intégrée.
- La compilation hors écran est temporaire et s'arrête lorsque son travail est terminé.

[Lire l'architecture](ARCHITECTURE.md) · [Explorer Power Runtime](POWER-RUNTIME.md) · [Examiner le modèle de menace](THREAT-MODEL.md) · [Comprendre la confidentialité](PRIVACY.md) · [Consulter la recherche communautaire](COMMUNITY-RESEARCH.md)

## Limites de sécurité et de confiance

| Limite | Règle du projet |
| --- | --- |
| Sources distantes | Les catalogues et listes HTTPS sont analysés comme des données de taille limitée ; les redirections, les schémas incorrects et les charges utiles exécutables sont rejetés. |
| Confiance du Filter Store | Les entrées intégrées et personnalisées affichent leur niveau de confiance. La popularité auprès de la communauté ne fait jamais passer à elle seule une entrée au niveau `verified`. |
| Code de l'extension | Le JavaScript, les scriptlets et les ressources de redirection sont livrés dans le paquet d'extension examiné, jamais depuis une URL au moment de l'exécution. |
| Autorisations | Les autorisations du filtrage principal sont documentées. L'autorisation `privacy` de Chrome n'est demandée que lorsque l'utilisateur active ces contrôles et peut être révoquée. |
| Données locales | Les paramètres, les filtres compilés et les diagnostics de taille du stockage restent sur l'appareil, sauf si l'utilisateur les exporte explicitement. |
| Intégrité de la version | La CI compile et valide l'artefact Chromium ; les versions publiées comportent une somme de contrôle SHA-256. |

Les problèmes de sécurité doivent être signalés en privé via les [avis de sécurité GitHub](https://github.com/kayurachann/uBlock-Plus/security/advisories/new), et non dans une issue publique. Consultez [SECURITY.md](../SECURITY.md) pour connaître la politique de signalement.

## MV3 : puissant, avec des limites clairement annoncées

| Disponible aujourd'hui | Limité par MV3 | Recherche future, facultative |
| --- | --- | --- |
| Blocage réseau DNR, filtrage cosmétique, scriptlets intégrés, listes personnalisées/importées, Filter Store, sélecteur/zapper, politiques contextuelles de fenêtres surgissantes par hôte, application par l'observateur des règles `$popup` stock empaquetées et du sous-ensemble pris en charge des filtres `$popup`/`$popunder` importés avec provenance expurgée espace/ligne source/type, et sauvegarde/restauration | La journalisation des requêtes en direct, les filtres procéduraux, l'observation asynchrone des fenêtres surgissantes, la sémantique du pare-feu dynamique, les opérations sur les en-têtes de réponse et le comportement des redirections n'offrent pas une parité exacte avec MV2 | Des adaptateurs Enterprise administrés et un compagnon natif open source installé indépendamment, sous réserve d'une RFC, du consentement et d'un examen de sécurité |

Le sous-ensemble pris en charge des filtres de fenêtres surgissantes importés est désormais appliqué par le runtime d'observation. Les conditions impossibles à représenter exactement—par exemple celles de type de domaine, de méthode de requête ou d'en-tête de réponse—restent explicitement différées au lieu d'être approximées. Les conditions `allow` différées sont conservées comme garde-fous conservateurs en échec ouvert (*fail-open*) : un tel garde-fou peut seulement différer la décision, jamais autoriser ou bloquer par approximation. Comme l'application suit les événements asynchrones d'onglet et de navigation de MV3, elle ne reproduit pas exactement l'exécution synchrone de MV2. Les règles DNR dynamiques et de session partagent un même quota de 1 000 regex ; elles ne disposent pas chacune de 1 000 règles.

La réécriture arbitraire du corps des réponses, une visibilité DNS/CNAME équivalente et le blocage précis selon la taille de la réponse ne sont pas disponibles avec les API publiques ordinaires des extensions MV3. Certaines syntaxes de filtre MV2 ne peuvent pas être traduites ; consultez la matrice des fonctionnalités avant de supposer une équivalence. Les correspondances de fenêtres surgissantes n'exposent localement qu'une provenance expurgée : espace, ligne source et type. La compilation des listes réseau importées consigne des motifs stables d'acceptation ou de report et les numéros des lignes sources ; un affichage plus riche de ce rapport dans le tableau de bord reste inscrit à la feuille de route.

## Feuille de route

<table>
<tr>
<th width="33%">Maintenant</th>
<th width="33%">Ensuite</th>
<th width="33%">Plus tard</th>
</tr>
<tr>
<td valign="top">

- Renforcer la Power Edition
- Valider les parcours du Filter Store
- Tester les chemins de redémarrage et de retour en arrière
- Établir des références pour le mode Low-memory

</td>
<td valign="top">

- Déduplication et partitionnement sûrs des règles
- Diagnostics locaux plus détaillés
- Amélioration de l'accessibilité et de l'i18n
- Rapports publics sur les régressions de performances

</td>
<td valign="top">

- Adaptateur Enterprise administré
- Recherche facultative sur un compagnon natif
- Provenance signée du catalogue et révocation

</td>
</tr>
</table>

Les éléments de la feuille de route ne sont pas des promesses de publication. Une fonctionnalité n'est livrée qu'après sa mise en œuvre, ses tests, la prise en charge de la migration et du retour en arrière, ainsi que les examens de sécurité, de confidentialité, de licence et de performances. [Voir la feuille de route communautaire complète →](ROADMAP.md)

## Développer et contribuer

```bash
npm ci
npm run lint
npm test
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

Les idées et les signalements sont les bienvenus via les formulaires d'issue structurés du dépôt :

- [Proposer une fonctionnalité ou signaler un bug](https://github.com/kayurachann/uBlock-Plus/issues/new/choose)
- [Soumettre une entrée au Filter Store](https://github.com/kayurachann/uBlock-Plus/issues/new?template=filter_store_submission.yml)
- [Lire le guide de contribution](../CONTRIBUTING.md)
- [Comprendre la gouvernance de la communauté](COMMUNITY-GOVERNANCE.md)
- [Examiner la responsabilité et les limites des modules](MODULE-PLAN.md)

Le dépôt conserve l'historique Git du projet d'origine et garde [`gorhill/uBlock`](https://github.com/gorhill/uBlock) configuré comme remote `upstream` destiné uniquement à la récupération.

## Crédits et licence

uBlock Plus+ est une œuvre dérivée fondée sur [uBlock Origin](https://github.com/gorhill/uBlock) et son implémentation MV3/uBO Lite. Les mentions de copyright, les en-têtes des sources, l'historique des auteurs et les attributions tierces sont conservés. Consultez [NOTICE.md](../NOTICE.md).

Distribué sous la [licence publique générale GNU version 3.0 ou ultérieure](../LICENSE.txt).

<div align="center">

**Développé ouvertement, façonné par ses utilisateurs.**

[Retour en haut ↑](#ublock-plus)

</div>
