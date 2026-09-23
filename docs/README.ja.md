<!-- readme-refresh-pending -->
> **翻訳の更新状況：** この旧版の翻訳は、2026年9月6日のドキュメント更新をまだ完全には反映していません。最新のChrome画面、インストール手順、テスト結果は [English](../README.md) または [Tiếng Việt](README.vi.md) を参照してください。公開済みプレビュー版は最新ソースより古い場合があります。

<div align="center">

<img src="assets/readme/hero.png" alt="Chromiumのページが読み込まれる前に、広告、トラッカー、Cookie、その他の不要なWebリクエストを盾がフィルタリングするイメージ" width="1100">

<sub>コンセプトイラスト · Windowsでは任意の自動更新に対応したサイドロード用プレリリースです</sub>

# uBlock Plus+

### コミュニティの力で作る、Chromium Manifest V3向けコンテンツブロッカー

**サイドロード優先 · ローカル優先 · オープンソース · ユーザーによる制御**

[![MV3 Chromium CI](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml/badge.svg)](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml)
[![Latest release](https://img.shields.io/github/v/release/kayurachann/uBlock-Plus?include_prereleases&label=pre--release&color=3b82f6)](https://github.com/kayurachann/uBlock-Plus/releases)
[![Chromium 130+](https://img.shields.io/badge/Chromium-130%2B-4285F4?logo=googlechrome&logoColor=white)](#quick-start)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-8b5cf6)](ARCHITECTURE.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-22c55e)](../LICENSE.txt)

[English](../README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [**日本語**](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [简体中文](README.zh_CN.md) · [繁體中文](README.zh_TW.md)

[**最新のプレビューをダウンロード**](https://github.com/kayurachann/uBlock-Plus/releases) · [機能一覧](FEATURE-MATRIX.md) · [アーキテクチャ](ARCHITECTURE.md) · [Filter Store](FILTER-STORE.md) · [ロードマップ](ROADMAP.md)

</div>

---

uBlock Plus+は、Chromium MV3向けに独立して開発されているGPLライセンスのコンテンツブロッカーです。実績のある上流のフィルタリング／コンパイラ基盤に、コミュニティのFilter Store、移行可能な設定、明示的な上級者向け制御、メモリを意識した動作を組み合わせています。プロジェクト運営のテレメトリサービスやリモート実行コードは使用しません。

> [!IMPORTANT]
> **リリース状況:** **パッケージ化されていない拡張機能を読み込む**で一度だけインストールするサイドロード用プレリリースで、任意の[Windows用アップデーター](AUTO-UPDATE.md)を使えば以降のリリースが自動的にインストールされます。uBlock Plus+は独立したフォークであり、uBlock Originの公式リリースではなく、Raymond Hill氏の推奨を受けたものでもありません。Chrome MV3では、元のMV2拡張機能で利用できたブロッキング機能のすべてが公開されているわけではありません。サイドロードによりChrome Web Storeの配布ポリシーは回避できますが、DNRの上限、Service Workerのライフサイクル規則、ブラウザのセキュリティ境界がなくなるわけでは**ありません**。[正直な互換性一覧](FEATURE-MATRIX.md)を参照してください。

## 選択権を中心にした設計

<table>
<tr>
<td width="50%" valign="top">

### 🛡️ 多層型コンテンツブロック

静的・動的・セッションDNRルールが、コスメティックフィルタリング、同梱スクリプトレット、厳格ブロック、コンテキスト対応のSmart Popup Blockerと連携します。

</td>
<td width="50%" valign="top">

### 🧩 コミュニティFilter Store

同梱のコミュニティカタログを閲覧したり、互換性のあるHTTPSリポジトリを最大8件追加したりできます。リモートリストは常にフィルタの**データ**として扱われ、実行可能な拡張コードとして扱われることはありません。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 サイトごとの制御

サイトごとのフィルタリングモードを選択し、マッチしたルールの診断を確認できます。ページを個別に調整したい場合は、要素ピッカー、ザッパー、アンピッカーを利用できます。

</td>
<td width="50%" valign="top">

### 🌱 メモリを意識したプロファイル

`auto`、`balanced`、`low-memory`から選択できます。Low-memoryモードは、順次コンパイル、上限付きキャッシュ、安全なクリーンアップを使用し、有効なフィルタを黙って無効化することはありません。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📦 持ち運べる設定

主要設定、購読、リポジトリ、ポップアップポリシー、カスタムフィルタをエクスポートして復元できます。同梱カタログは出発点であり、利用先を固定する仕組みではありません。

</td>
<td width="50%" valign="top">

### 🔐 プライバシーを前提にした設計

フィルタリングとストレージ診断はローカルに留まります。プロジェクトの分析アカウント、広告SDK、閲覧履歴サービスはありません。Chromeのプライバシー制御には、別途、取り消し可能な権限が必要です。

</td>
</tr>
</table>

Power UIの全文字列は、英語、ドイツ語、スペイン語、フランス語、日本語、韓国語、ロシア語、ベトナム語、簡体字中国語、繁体字中国語に翻訳されています。ほかの61の同梱ロケールには、ビルド時に決定的な英語フォールバックが適用されるため、コミュニティ翻訳の完成を待つ間も新しいコントロールが空欄になることはありません。

<div align="center">

[すべての機能を見る →](FEATURE-MATRIX.md)

</div>

## 実際の動作

<sub>個人の閲覧データを含まない新規Edgeプロファイルで、展開済みv1.0.0アーティファクトを撮影</sub>

<table>
<tr>
<td width="62%" valign="top">

<img src="assets/readme/filter-store.png" alt="DNR上限の見積もり、3つのバンドル、最初のコミュニティフィルタカードを表示する実際のuBlock Plus+ Filter Store">

<strong>Filter Store</strong><br>
コミュニティの項目を閲覧し、上限への影響を確認して、用途別バンドルを明示的に有効化できます。

</td>
<td width="38%" valign="top">

<img src="assets/readme/memory-settings.png" alt="Autoモード、実効Balanced設定、ローカルストレージ診断を表示する実際のuBlock Plus+ Memory Profile設定">

<strong>Memory Profile</strong><br>
Auto、Balanced、Low memoryを選択し、実際のRAM使用量ではなくローカルのキャッシュ／ストレージ指標を確認できます。

</td>
</tr>
</table>

<a id="quick-start"></a>

## クイックスタート

<div align="center">

<img src="assets/readme/install-flow.svg" alt="ダウンロードと展開、SHA-256検証、展開済み拡張機能の読み込み、表示された場合のユーザースクリプト許可という4つの手順" width="1100">

</div>

### リリースをインストール

1. [GitHub Releases](https://github.com/kayurachann/uBlock-Plus/releases)から`uBlock-Plus_*.chromium.zip`と対応する`.sha256`ファイルをダウンロードします。
2. チェックサムを検証してから、ユーザープロファイル内に新しく作った、拡張機能専用の空のフォルダーにZIPを展開します。Windowsでは`%LOCALAPPDATA%\uBlockPlus\Extension`をおすすめします。ドライブのルート、`C:\`の直下に作ったフォルダー、およびその中のフォルダー（`C:\Extensions`や`C:\Extensions\uBlock-Plus`など）は使わないでください。Windows用アップデーターは、ドライブのルート、システムフォルダーやプロファイルフォルダーそのもの、PCのほかのユーザーが変更できるフォルダーを拒否します。すでにそのようなフォルダーにインストールしている場合は、`%LOCALAPPDATA%\uBlockPlus\Extension`に移してください。[フォルダーの条件](AUTO-UPDATE.md#folder-rules)と[既存のインストールの移動](AUTO-UPDATE.md#moving-an-existing-installation)を参照してください。
3. `chrome://extensions`または`edge://extensions`を開きます。
4. **デベロッパーモード**を有効にし、**パッケージ化されていない拡張機能を読み込む**を選び、`manifest.json`を含む展開先フォルダーを指定します。その後も**デベロッパーモード**はオンのままにしてください。オフにすると、Chromeはパッケージ化されていない拡張機能を無効にします。
5. Chrome 138以降では拡張機能の**詳細**ページを開き、**ユーザースクリプトを許可**を有効にします。Chrome 130～137では、代わりに全体の**デベロッパーモード**スイッチを使用します。インストール後にいずれかのスイッチを変更した場合は、拡張機能カードの**再読み込み**をクリックし、Service Workerのコンテキストに新しいAPI状態を認識させてください。これにより、対応するインポート済みコスメティックフィルタと、同梱許可リスト内のスクリプトレットを登録できます。Chromeの[`userScripts`ガイド](https://developer.chrome.com/docs/extensions/reference/api/userScripts)も参照してください。

> [!NOTE]
> どのインストール環境でも、約6時間ごとに`api.github.com`で新しいリリースの有無が確認されます。閲覧データは送信されません。Windowsでは、1.2.0以降に同梱されたアップデーターが新しいバージョンを自動的にインストールします。設定は一度だけです。読み込んだ拡張機能フォルダー内の`updater\install-updater.cmd`をダブルクリックし（管理者権限は不要）、**ダッシュボード → 設定 → アップデート**で**アップデーターを許可**を選択します。Chromeがネイティブアプリケーションとの通信の許可を求めたら許可してください。その後uBlock Plus+が一度だけ再起動し、**アップデート**セクションを再び開きます。代わりに**今すぐ再起動**が表示された場合は、それを選択してください。以降の新しいバージョンは、ダウンロード後にSHA-256チェックサムと拡張機能の同一性を検証し、以前のバージョンをバックアップしたうえでインストールされます。フォルダーにuBlock Plus+に含まれないファイルがある間、アップデーターは何も変更しません。アップデーターを使わない場合（macOSやLinuxなど）は[Releases](https://github.com/kayurachann/uBlock-Plus/releases)を確認し、フォルダーの中身を新しいバージョンに置き換えてから拡張機能を再読み込みしてください。そのフォルダーのアップデーターを削除するには、コマンドプロンプトで`"%LOCALAPPDATA%\uBlockPlus\Extension\updater\install-updater.cmd" -Uninstall`を実行します（別のフォルダーの場合はそのパスを使います）。ブラウザーへの登録は、ほかに登録済みのインストールが残っていない場合にだけ削除されます。このリポジトリのアーティファクトだけをインストールし、提供されるSHA-256チェックサムを検証してください。詳細とトラブルシューティングは[AUTO-UPDATE.md](AUTO-UPDATE.md)を参照してください。

手順1と2、およびアップデーターの設定は、次のPowerShellコマンドでまとめて行うこともできます。最新のリリースを`%LOCALAPPDATA%\uBlockPlus\Extension`にダウンロードします。このフォルダーは空か、まだ存在しない必要があります。その後、このフォルダーをパッケージ化されていない拡張機能として読み込み、**アップデーターを許可**を選択してください。

```powershell
$installer = Join-Path $env:TEMP 'install-updater.ps1'
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/kayurachann/uBlock-Plus/main/platform/mv3/updater/install-updater.ps1 -OutFile $installer
powershell -ExecutionPolicy Bypass -File $installer
```

<details>
<summary><strong>Windowsでリリースのチェックサムを検証</strong></summary>

```powershell
(Get-FileHash .\uBlock-Plus_1.2.0.chromium.zip -Algorithm SHA256).Hash
Get-Content .\uBlock-Plus_1.2.0.chromium.zip.sha256
```

16進ハッシュは一致していなければなりません（大文字と小文字は区別されません）。

</details>

### ソースからビルド

要件: Chrome／ChromiumまたはEdge 130以降、サブモジュールを扱えるGit、Node.js 22以降、ビルド時のフィルタデータ取得に必要なネットワーク接続。

<details open>
<summary><strong>Windows / PowerShell</strong></summary>

```powershell
git clone --recurse-submodules https://github.com/kayurachann/uBlock-Plus.git
cd uBlock-Plus
# Windowsは既定で署名のないローカルスクリプトをブロックします。このウィンドウでのみ許可します。
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
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

# 任意: バージョン付きZIPとSHA-256ファイルも作成します。
VERSION=$(node -p "require('./package.json').version")
tools/make-mv3.sh chromium "$VERSION"
```

</details>

ブラウザの拡張機能ページから`dist/build/uBlockPlus.chromium`を読み込んでください。バージョンを指定したPowerShellコマンドと、任意のバージョン付きシェルコマンドは、`dist/build/`にZIPとチェックサムを作成します。通常の`make mv3-chromium`は展開済みディレクトリだけを作成します。

## 仕組み

<div align="center">

<img src="assets/readme/feature-map.svg" alt="ユーザーが選択したソースから検証済みコンパイルを経てChromiumのDNRおよびコスメティックフィルタリングに至る処理フロー" width="1100">

</div>

- Chrome DNRは、リクエストごとにService Workerを起動することなくネットワークフィルタリングを処理します。
- イベント駆動型Service Workerは、設定、カタログ状態、移行、復旧可能なルール更新を管理します。
- インポートしたリストはローカルでDNRおよびコスメティックデータにコンパイルされます。スクリプトレットは、あらかじめ同梱の許可リストに存在する必要があります。
- オフスクリーンでのコンパイルは一時的で、処理が完了すると閉じます。

[アーキテクチャを読む](ARCHITECTURE.md) · [Power Runtimeを見る](POWER-RUNTIME.md) · [脅威モデルを確認](THREAT-MODEL.md) · [プライバシーについて](PRIVACY.md) · [コミュニティ調査を読む](COMMUNITY-RESEARCH.md)

## セキュリティと信頼境界

| 境界 | プロジェクトの規則 |
| --- | --- |
| リモートソース | HTTPSカタログとリストは上限付きデータとして解析され、リダイレクト、不正なスキーマ、実行可能なペイロードは拒否されます。 |
| Filter Storeの信頼性 | 組み込み項目とカスタム項目には信頼レベルが表示されます。コミュニティでの人気だけで項目が`verified`に昇格することはありません。 |
| 拡張機能コード | JavaScript、スクリプトレット、リダイレクトリソースは、レビュー済みの拡張機能パッケージ内に同梱され、実行時URLから取得されることはありません。 |
| 権限 | 中核となるフィルタリング権限は文書化されています。Chromeの`privacy`権限は、ユーザーが該当する制御を有効にした場合にだけ要求され、取り消せます。任意の`nativeMessaging`権限は、ユーザーが**アップデーターを許可**を選択したときにだけ要求されます。 |
| ローカルデータ | 設定、コンパイル済みフィルタ、ストレージ容量の診断は、ユーザーが明示的にエクスポートしない限り端末内に留まります。 |
| リリースの完全性 | CIはChromiumアーティファクトをビルドして検証し、リリースにはSHA-256チェックサムが含まれます。 |

セキュリティ上の問題は、公開Issueではなく[GitHub Security Advisories](https://github.com/kayurachann/uBlock-Plus/security/advisories/new)から非公開で報告してください。報告方針は[SECURITY.md](../SECURITY.md)を参照してください。

## MV3の能力と正直な制約

| 現在利用可能 | MV3による制約 | 将来の研究—任意 |
| --- | --- | --- |
| DNRネットワークブロック、コスメティックフィルタリング、同梱スクリプトレット、カスタム／インポートリスト、Filter Store、ピッカー／ザッパー、コンテキスト対応のホスト別ポップアップポリシー、同梱stock `$popup`ルールと対応するインポート済み`$popup`／`$popunder`サブセットのオブザーバー実行（realm・ソース行・種別のみの秘匿化された来歴）、バックアップ／復元 | リクエストのライブログ、プロシージャルフィルタ、非同期ポップアップ監視、動的ファイアウォールの意味論、レスポンスヘッダー操作、リダイレクト動作はMV2と完全には同等ではありません | Managed Enterpriseアダプターと、別途インストールするフィルタリング用（DNS／プロキシなど）のオープンソースのネイティブコンパニオン。RFC、同意、セキュリティレビューが前提です。現在出荷されているネイティブコンポーネントは、ユーザー自身がインストールする任意のWindows用アップデーター（1.2.0以降）だけです |

対応しているインポート済みポップアップフィルタのサブセットは、オブザーバーランタイムで適用されます。`domainType`、`requestMethods`、`responseHeaders`など正確に表現できない条件は近似せず、明示的に保留されます。保留された`allow`条件は保守的なfail-openガードとして保持され、ガードができるのは判断の保留だけで、近似的な許可やブロックは行いません。適用はMV3の非同期なタブ／ナビゲーションイベントに従うため、MV2の同期処理と完全に同等ではありません。動的DNRルールとセッションDNRルールは単一の1,000件のregex枠を共有し、それぞれが1,000件を持つわけではありません。

任意のレスポンス本文書き換え、同等のDNS／CNAME可視性、レスポンスサイズに基づく厳密なブロックは、通常の公開MV3拡張APIでは利用できません。一部のMV2フィルタ構文は変換できないため、同等性を仮定する前に機能一覧を確認してください。ポップアップの一致結果がローカルで示す来歴は、秘匿化されたrealm、ソース行、種別だけです。インポートしたネットワークリストのコンパイルは、安定した受理理由または保留理由とソース行番号を記録しますが、そのレポートをダッシュボードでより詳しく表示する機能は、まだロードマップ上の作業です。

## ロードマップ

<table>
<tr>
<th width="33%">現在</th>
<th width="33%">次</th>
<th width="33%">将来</th>
</tr>
<tr>
<td valign="top">

- Power Editionの堅牢化
- Filter Storeワークフローの検証
- 再起動とロールバック経路のテスト
- Low-memory基準値の確立

</td>
<td valign="top">

- 安全なルール重複排除とシャーディング
- より詳しいローカル診断
- アクセシビリティと国際化の仕上げ
- パフォーマンス回帰レポートの公開

</td>
<td valign="top">

- Managed Enterpriseアダプター
- フィルタリング用の任意のネイティブコンパニオンの調査
- 署名付きカタログの来歴と失効

</td>
</tr>
</table>

ロードマップの項目はリリースの約束ではありません。機能は、実装、テスト、移行／ロールバック対応、セキュリティ、プライバシー、ライセンス、性能のレビューが完了してから出荷されます。[コミュニティロードマップ全体を見る →](ROADMAP.md)

## 開発と貢献

```bash
npm ci
npm run lint
npm test
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

アイデアや報告は、リポジトリの定型Issueフォームから歓迎しています。

- [機能を提案または不具合を報告](https://github.com/kayurachann/uBlock-Plus/issues/new/choose)
- [Filter Store項目を提出](https://github.com/kayurachann/uBlock-Plus/issues/new?template=filter_store_submission.yml)
- [コントリビューションガイドを読む](../CONTRIBUTING.md)
- [コミュニティガバナンスを理解する](COMMUNITY-GOVERNANCE.md)
- [モジュールの所有範囲と境界を確認](MODULE-PLAN.md)

このリポジトリは上流のGit履歴を保持し、[`gorhill/uBlock`](https://github.com/gorhill/uBlock)を取得専用の`upstream`リモートとして維持しています。

## クレジットとライセンス

uBlock Plus+は[uBlock Origin](https://github.com/gorhill/uBlock)および上流から継承したMV3コンポーネントを基にした派生作品です。著作権、ソースヘッダー、作者履歴、第三者への帰属表示は保持されています。[NOTICE.md](../NOTICE.md)を参照してください。

[GNU General Public License v3.0以降](../LICENSE.txt)の下で公開されています。

<div align="center">

**オープンに作り、ユーザーとともに形にする。**

[トップへ戻る ↑](#ublock-plus)

</div>
