<div align="center">

<img src="assets/readme/hero.png" alt="盾牌在 Chromium 頁面載入前篩選廣告、追蹤器、Cookie 和其他不需要的網路請求的插圖" width="1100">

<sub>概念插圖 · v1.0.0 是需要手動更新的側載預先發佈版本</sub>

# uBlock Plus+

### 由社群驅動，為 Chromium Manifest V3 打造的內容封鎖器

**側載優先 · 本機優先 · 開放原始碼 · 由使用者掌控**

[![MV3 Chromium CI](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml/badge.svg)](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml)
[![最新版本](https://img.shields.io/github/v/release/kayurachann/uBlock-Plus?include_prereleases&label=pre--release&color=3b82f6)](https://github.com/kayurachann/uBlock-Plus/releases)
[![Chromium 130+](https://img.shields.io/badge/Chromium-130%2B-4285F4?logo=googlechrome&logoColor=white)](#quick-start)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-8b5cf6)](ARCHITECTURE.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-22c55e)](../LICENSE.txt)

[English](../README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [简体中文](README.zh_CN.md) · [**繁體中文**](README.zh_TW.md)

[**下載最新預覽版**](https://github.com/kayurachann/uBlock-Plus/releases) · [功能矩陣](FEATURE-MATRIX.md) · [架構](ARCHITECTURE.md) · [Filter Store](FILTER-STORE.md) · [發展藍圖](ROADMAP.md)

</div>

---

uBlock Plus+ 是一款適用於 Chromium MV3、採用 GPL 授權的獨立內容封鎖器。它將經過驗證的上游篩選與編譯基礎，和社群 Filter Store、可攜式設定、明確的進階使用者控制以及重視記憶體的運作方式結合起來，同時不使用專案遙測服務，也不載入遠端可執行程式碼。

> [!IMPORTANT]
> **發佈狀態：** v1.0.0 是供手動側載的預先發佈版本，不會自動更新。uBlock Plus+ 不是 uBlock Origin 或 uBO Lite 的官方版本，也未獲 Raymond Hill 認可。Chrome MV3 並未提供原始 MV2 擴充功能可用的全部封鎖原語。側載可以避開 Chrome 線上應用程式商店的發佈政策，但**不會**消除 DNR 配額、Service Worker 生命週期規則或瀏覽器安全邊界。請參閱[如實說明的相容性矩陣](FEATURE-MATRIX.md)。

## 以你的選擇為核心

<table>
<tr>
<td width="50%" valign="top">

### 🛡️ 分層內容封鎖

靜態、動態和工作階段 DNR 規則會與外觀篩選、內建 scriptlet、嚴格封鎖以及可感知情境的智慧型彈出視窗封鎖器協同運作。

</td>
<td width="50%" valign="top">

### 🧩 社群 Filter Store

瀏覽內建的社群目錄，或加入最多八個相容的 HTTPS 儲存庫。每個遠端清單都只會作為篩選器**資料**處理，絕不會作為可執行的擴充功能程式碼。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 每個網站均可控制

可為各網站選擇篩選模式、檢查相符規則的診斷資訊，並在頁面需要個人化處理時使用元素選取器、移除器或取消選取器。

</td>
<td width="50%" valign="top">

### 🌱 重視記憶體的設定檔

可選擇 `auto`、`balanced` 或 `low-memory`。低記憶體模式採用循序編譯、有界快取和安全清理，不會暗中停用已啟用的篩選器。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📦 設定可自由攜帶

匯出並還原核心設定、訂閱、儲存庫、彈出視窗策略和自訂篩選器。內建目錄只是起點，而不是綁定機制。

</td>
<td width="50%" valign="top">

### 🔐 隱私融入設計

篩選與儲存空間診斷資訊會保留在本機。專案不設分析帳戶、不含廣告 SDK，也沒有瀏覽記錄服務；Chrome 隱私控制需要另外授予且可撤銷的權限。

</td>
</tr>
</table>

完整的 Power 介面字串已翻譯為英文、德文、西班牙文、法文、日文、韓文、俄文、越南文、簡體中文和繁體中文。其餘 61 個內建語言地區會在建置時確定地回復為英文，因此在社群翻譯補齊之前，新控制項也不會顯示空白。

<div align="center">

[探索全部功能 →](FEATURE-MATRIX.md)

</div>

## 查看實際效果

<sub>擷取自全新 Edge 設定檔中以未封裝方式載入的 v1.0.0 成品 · 不含個人瀏覽資料</sub>

<table>
<tr>
<td width="62%" valign="top">

<img src="assets/readme/filter-store.png" alt="實際的 uBlock Plus+ Filter Store 畫面，顯示 DNR 配額估算、三個套件組合和第一張社群篩選器卡片">

<strong>Filter Store</strong><br>
瀏覽社群項目、檢查配額影響，並由你明確啟用帶有特定取向的套件組合。

</td>
<td width="38%" valign="top">

<img src="assets/readme/memory-settings.png" alt="實際的 uBlock Plus+ 記憶體設定檔畫面，顯示自動模式、目前生效的平衡模式和本機儲存空間診斷">

<strong>記憶體設定檔</strong><br>
選擇自動、平衡或低記憶體模式，並檢查本機快取與儲存空間指標；這些指標並非即時 RAM 使用量。

</td>
</tr>
</table>

<a id="quick-start"></a>

## 快速開始

<div align="center">

<img src="assets/readme/install-flow.svg" alt="四個步驟：下載並解壓縮、驗證 SHA-256、載入未封裝的擴充功能，然後在出現相關選項時允許使用者指令碼" width="1100">

</div>

### 安裝發佈版本

1. 從 [GitHub Releases](https://github.com/kayurachann/uBlock-Plus/releases) 下載 `uBlock-Plus_*.chromium.zip` 及其對應的 `.sha256` 檔案。
2. 驗證總和檢查碼，然後將 ZIP 解壓縮到固定資料夾。
3. 開啟 `chrome://extensions` 或 `edge://extensions`。
4. 啟用**開發人員模式**，選擇**載入未封裝項目**，然後選取包含 `manifest.json` 的解壓縮資料夾。
5. 在 Chrome 138 以上版本中，開啟該擴充功能的**詳細資料**頁面並啟用**允許使用者指令碼**。Chrome 130–137 改用全域**開發人員模式**開關。如果安裝後變更任一開關，請按一下擴充功能資訊卡上的**重新載入**，讓其 Service Worker 情境識別新的 API 狀態。如此一來，受支援的匯入外觀篩選器和內建允許清單 scriptlet 才能完成註冊。請參閱 Chrome 的 [`userScripts` 指南](https://developer.chrome.com/docs/extensions/reference/api/userScripts)。

> [!NOTE]
> 側載的擴充功能不會透過 Chrome 線上應用程式商店更新。請關注 [Releases](https://github.com/kayurachann/uBlock-Plus/releases)，並在新版本發佈後替換未封裝的建置版本。只安裝來自本儲存庫的成品，並驗證隨附的 SHA-256 總和檢查碼。

<details>
<summary><strong>在 Windows 上驗證發佈套件總和檢查碼</strong></summary>

```powershell
(Get-FileHash .\uBlock-Plus_1.0.0.chromium.zip -Algorithm SHA256).Hash
Get-Content .\uBlock-Plus_1.0.0.chromium.zip.sha256
```

兩個十六進位雜湊值必須一致，字母大小寫不影響結果。

</details>

### 從原始碼建置

需求：Chrome/Chromium 或 Edge 130+、支援子模組的 Git、Node.js 22+，以及用於在建置時取得篩選器資料的網路連線。

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

# 選用：同時建立含版本號的 ZIP 和 SHA-256 檔案。
VERSION=$(node -p "require('./package.json').version")
tools/make-mv3.sh chromium "$VERSION"
```

</details>

從瀏覽器的擴充功能頁面載入 `dist/build/uBlockPlus.chromium`。含版本號的 PowerShell 指令以及選用的含版本號 shell 指令會在 `dist/build/` 下建立 ZIP 和總和檢查碼；直接執行 `make mv3-chromium` 只會建立未封裝目錄。

## 運作方式

<div align="center">

<img src="assets/readme/feature-map.svg" alt="篩選流程：使用者選擇來源，經過驗證和編譯，再交由 Chromium 中的 DNR 與外觀篩選處理" width="1100">

</div>

- Chrome DNR 負責網路篩選，不必為每個請求喚醒 Service Worker。
- 事件驅動的 Service Worker 管理設定、目錄狀態、移轉以及可復原的規則更新。
- 匯入的清單會在本機編譯為 DNR 和外觀資料；scriptlet 必須已存在於內建允許清單中。
- 離屏編譯是暫時性的，工作完成後便會關閉。

[閱讀架構文件](ARCHITECTURE.md) · [探索 Power Runtime](POWER-RUNTIME.md) · [檢視威脅模型](THREAT-MODEL.md) · [瞭解隱私](PRIVACY.md)

## 安全與信任邊界

| 邊界 | 專案規則 |
| --- | --- |
| 遠端來源 | HTTPS 目錄和清單會作為有界資料剖析；重新導向、格式錯誤的結構描述和可執行承載內容都會遭到拒絕。 |
| Filter Store 信任 | 內建和自訂項目都會顯示其信任等級。僅憑社群熱門程度絕不會將項目提升為 `verified`。 |
| 擴充功能程式碼 | JavaScript、scriptlet 和重新導向資源均隨經過審查的擴充功能套件提供，絕不會從執行階段 URL 載入。 |
| 權限 | 核心篩選權限已有文件說明。只有使用者啟用相關控制時才會要求 Chrome 的 `privacy` 權限，而且該權限可以撤銷。 |
| 本機資料 | 設定、已編譯篩選器和儲存空間大小診斷資訊會留在裝置上，除非使用者明確匯出。 |
| 發佈完整性 | CI 會建置並驗證 Chromium 成品；發佈套件附帶 SHA-256 總和檢查碼。 |

安全問題應透過 [GitHub Security Advisories](https://github.com/kayurachann/uBlock-Plus/security/advisories/new) 私下回報，而不是提交公開 issue。回報政策請參閱 [SECURITY.md](../SECURITY.md)。

## MV3：功能強大，也如實說明限制

| 目前可用 | 受 MV3 限制 | 未來研究——選用 |
| --- | --- | --- |
| DNR 網路封鎖、外觀篩選、內建 scriptlet、自訂/匯入清單、Filter Store、元素選取器/移除器、可感知情境的各主機彈出視窗策略，以及備份/還原 | 即時請求記錄、程序式篩選器、匯入彈出視窗篩選器的執行、動態防火牆語意、回應標頭操作和重新導向行為僅能部分等同於 MV2 | 受管理的企業轉接器，以及獨立安裝的開放原始碼原生伴隨程式；均須經過 RFC、使用者同意和安全審查 |

一般公開 MV3 擴充功能 API 不提供任意回應本文重寫、等效的 DNS/CNAME 可見性或精確的依回應大小封鎖。部分 MV2 篩選語法無法轉換；在假設功能等效之前，請查閱功能矩陣。匯入網路清單的編譯現在會記錄穩定的拒絕原因和來源行號；在控制台中以更豐富的形式呈現該報告仍屬於發展藍圖工作。

## 發展藍圖

<table>
<tr>
<th width="33%">現在</th>
<th width="33%">下一步</th>
<th width="33%">稍後</th>
</tr>
<tr>
<td valign="top">

- 強化 Power Edition
- 驗證 Filter Store 工作流程
- 測試重新啟動與復原路徑
- 建立低記憶體基準

</td>
<td valign="top">

- 安全的規則去重與分片
- 更豐富的本機診斷
- 改善無障礙體驗與國際化
- 公開效能迴歸報告

</td>
<td valign="top">

- 受管理的企業轉接器
- 選用原生伴隨程式研究
- 已簽署目錄的來源證明與撤銷機制

</td>
</tr>
</table>

發展藍圖項目不是發佈承諾。只有在完成實作、測試、移轉/復原處理，並通過安全、隱私、授權和效能審查後，功能才會發佈。[查看完整的社群發展藍圖 →](ROADMAP.md)

## 開發與貢獻

```bash
npm ci
npm run lint
npm test
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

歡迎透過儲存庫的結構化 issue 表單提交想法和報告：

- [提出功能建議或回報錯誤](https://github.com/kayurachann/uBlock-Plus/issues/new/choose)
- [提交 Filter Store 項目](https://github.com/kayurachann/uBlock-Plus/issues/new?template=filter_store_submission.yml)
- [閱讀貢獻指南](../CONTRIBUTING.md)
- [瞭解社群治理](COMMUNITY-GOVERNANCE.md)
- [檢視模組歸屬與邊界](MODULE-PLAN.md)

本儲存庫會保留上游 Git 歷史，並將 [`gorhill/uBlock`](https://github.com/gorhill/uBlock) 設定為僅供擷取的 `upstream` 遠端儲存庫。

## 致謝與授權

uBlock Plus+ 是以 [uBlock Origin](https://github.com/gorhill/uBlock) 及其 MV3/uBO Lite 實作為基礎的衍生作品。專案會保留著作權、原始碼標頭、作者歷史和第三方署名。請參閱 [NOTICE.md](../NOTICE.md)。

本專案依據 [GNU 通用公共授權條款 v3.0 或更新版本](../LICENSE.txt)發佈。

<div align="center">

**公開打造，由使用者共同塑造。**

[返回頂端 ↑](#ublock-plus)

</div>
