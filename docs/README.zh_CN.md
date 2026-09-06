<!-- readme-refresh-pending -->
> **翻译更新说明：** 此旧版译文尚未完整同步 2026 年 9 月 6 日的文档更新。最新 Chrome 截图、安装说明及测试结果请参阅 [English](../README.md) 或 [Tiếng Việt](README.vi.md)。已发布的预览版可能早于当前源码。

<div align="center">

<img src="assets/readme/hero.png" alt="盾牌在 Chromium 页面加载前过滤广告、跟踪器、Cookie 和其他不需要的网络请求的插图" width="1100">

<sub>概念插图 · v1.0.0 是需要手动更新的侧载预发布版本</sub>

# uBlock Plus+

### 由社区驱动，为 Chromium Manifest V3 打造的内容拦截器

**侧载优先 · 本地优先 · 开源 · 由用户掌控**

[![MV3 Chromium CI](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml/badge.svg)](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml)
[![最新版本](https://img.shields.io/github/v/release/kayurachann/uBlock-Plus?include_prereleases&label=pre--release&color=3b82f6)](https://github.com/kayurachann/uBlock-Plus/releases)
[![Chromium 130+](https://img.shields.io/badge/Chromium-130%2B-4285F4?logo=googlechrome&logoColor=white)](#quick-start)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-8b5cf6)](ARCHITECTURE.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-22c55e)](../LICENSE.txt)

[English](../README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [한국어](README.ko.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [**简体中文**](README.zh_CN.md) · [繁體中文](README.zh_TW.md)

[**下载最新预览版**](https://github.com/kayurachann/uBlock-Plus/releases) · [功能矩阵](FEATURE-MATRIX.md) · [架构](ARCHITECTURE.md) · [Filter Store](FILTER-STORE.md) · [路线图](ROADMAP.md)

</div>

---

uBlock Plus+ 是一款面向 Chromium MV3、采用 GPL 许可证的独立内容拦截器。它将经过验证的上游过滤与编译基础，与社区 Filter Store、可移植配置、明确的高级用户控制以及注重内存的运行方式结合起来，同时不使用项目遥测服务，也不加载远程可执行代码。

> [!IMPORTANT]
> **发布状态：** v1.0.0 是供手动侧载的预发布版本，不会自动更新。uBlock Plus+ 是独立分支，不是 uBlock Origin 的官方版本，也未得到 Raymond Hill 的认可。Chrome MV3 并未提供原 MV2 扩展可用的全部拦截原语。侧载可以避开 Chrome 应用商店的分发政策，但**不会**消除 DNR 配额、Service Worker 生命周期规则或浏览器安全边界。请参阅[如实说明的兼容性矩阵](FEATURE-MATRIX.md)。

## 围绕你的选择而设计

<table>
<tr>
<td width="50%" valign="top">

### 🛡️ 分层内容拦截

静态、动态和会话 DNR 规则与外观过滤、内置 scriptlet、严格拦截以及可感知上下文的智能弹出窗口拦截器协同工作。

</td>
<td width="50%" valign="top">

### 🧩 社区 Filter Store

浏览内置的社区目录，或添加最多八个兼容的 HTTPS 仓库。每个远程列表都只会作为过滤器**数据**处理，绝不会作为可执行的扩展代码。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 每个网站均可控制

可为各网站选择过滤模式、检查命中规则的诊断信息，并在页面需要个性化处理时使用元素选择器、移除器或取消选择器。

</td>
<td width="50%" valign="top">

### 🌱 注重内存的配置档

可选择 `auto`、`balanced` 或 `low-memory`。低内存模式采用顺序编译、有界缓存和安全清理，不会暗中停用已启用的过滤器。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📦 配置可自由携带

导出并恢复核心设置、订阅、仓库、弹出窗口策略和自定义过滤器。内置目录只是起点，而不是锁定机制。

</td>
<td width="50%" valign="top">

### 🔐 隐私融入设计

过滤与存储诊断信息保留在本地。项目不设分析账户，不含广告 SDK，也没有浏览历史服务；Chrome 隐私控制需要单独授予且可撤销的权限。

</td>
</tr>
</table>

完整的 Power 界面字符串已翻译为英语、德语、西班牙语、法语、日语、韩语、俄语、越南语、简体中文和繁体中文。其余 61 个内置语言区域会在构建时确定性地回退到英语，因此在社区翻译补齐之前，新控件也不会显示空白。

<div align="center">

[探索全部功能 →](FEATURE-MATRIX.md)

</div>

## 查看实际效果

<sub>截图来自全新的 Edge 配置文件中以解压方式加载的 v1.0.0 构件 · 不含个人浏览数据</sub>

<table>
<tr>
<td width="62%" valign="top">

<img src="assets/readme/filter-store.png" alt="真实的 uBlock Plus+ Filter Store 界面，显示 DNR 配额估算、三个组合包和第一张社区过滤器卡片">

<strong>Filter Store</strong><br>
浏览社区条目、检查配额影响，并由你明确启用带有特定取向的组合包。

</td>
<td width="38%" valign="top">

<img src="assets/readme/memory-settings.png" alt="真实的 uBlock Plus+ 内存配置界面，显示自动模式、当前生效的平衡模式和本地存储诊断">

<strong>内存配置</strong><br>
选择自动、平衡或低内存模式，并检查本地缓存与存储指标；这些指标并非实时 RAM 使用量。

</td>
</tr>
</table>

<a id="quick-start"></a>

## 快速开始

<div align="center">

<img src="assets/readme/install-flow.svg" alt="四个步骤：下载并解压、验证 SHA-256、加载已解压的扩展，然后在出现相关选项时允许用户脚本" width="1100">

</div>

### 安装发布版本

1. 从 [GitHub Releases](https://github.com/kayurachann/uBlock-Plus/releases) 下载 `uBlock-Plus_*.chromium.zip` 及其对应的 `.sha256` 文件。
2. 验证校验和，然后将 ZIP 解压到一个固定文件夹。
3. 打开 `chrome://extensions` 或 `edge://extensions`。
4. 启用**开发者模式**，选择**加载已解压的扩展程序**，然后选择包含 `manifest.json` 的解压文件夹。
5. 在 Chrome 138 及更高版本中，打开该扩展的**详细信息**页面并启用**允许用户脚本**。Chrome 130–137 改用全局**开发者模式**开关。如果安装后更改了任一开关，请点击扩展卡片上的**重新加载**，让其 Service Worker 上下文识别新的 API 状态。这样，受支持的导入外观过滤器和内置白名单 scriptlet 才能完成注册。请参阅 Chrome 的 [`userScripts` 指南](https://developer.chrome.com/docs/extensions/reference/api/userScripts)。

> [!NOTE]
> 侧载扩展不会通过 Chrome 应用商店更新。请关注 [Releases](https://github.com/kayurachann/uBlock-Plus/releases)，并在新版本发布后替换已解压的构建。只安装来自本仓库的构件，并验证随附的 SHA-256 校验和。

<details>
<summary><strong>在 Windows 上验证发布包校验和</strong></summary>

```powershell
(Get-FileHash .\uBlock-Plus_1.0.0.chromium.zip -Algorithm SHA256).Hash
Get-Content .\uBlock-Plus_1.0.0.chromium.zip.sha256
```

两个十六进制哈希值必须一致，字母大小写无关。

</details>

### 从源代码构建

要求：Chrome/Chromium 或 Edge 130+、支持子模块的 Git、Node.js 22+，以及用于在构建时获取过滤器数据的网络连接。

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

# 可选：同时创建带版本号的 ZIP 和 SHA-256 文件。
VERSION=$(node -p "require('./package.json').version")
tools/make-mv3.sh chromium "$VERSION"
```

</details>

从浏览器的扩展页面加载 `dist/build/uBlockPlus.chromium`。带版本号的 PowerShell 命令以及可选的带版本号 shell 命令会在 `dist/build/` 下创建 ZIP 和校验和；直接运行 `make mv3-chromium` 只会创建已解压目录。

## 工作原理

<div align="center">

<img src="assets/readme/feature-map.svg" alt="过滤流程：用户选择来源，经过验证和编译，再交由 Chromium 中的 DNR 与外观过滤处理" width="1100">

</div>

- Chrome DNR 负责网络过滤，无需为每个请求唤醒 Service Worker。
- 事件驱动的 Service Worker 管理设置、目录状态、迁移以及可恢复的规则更新。
- 导入的列表会在本地编译为 DNR 和外观数据；scriptlet 必须已存在于内置白名单中。
- 离屏编译是临时的，工作完成后会关闭。

[阅读架构文档](ARCHITECTURE.md) · [探索 Power Runtime](POWER-RUNTIME.md) · [查看威胁模型](THREAT-MODEL.md) · [了解隐私](PRIVACY.md) · [查看社区研究](COMMUNITY-RESEARCH.md)

## 安全与信任边界

| 边界 | 项目规则 |
| --- | --- |
| 远程来源 | HTTPS 目录和列表会作为有界数据解析；重定向、格式错误的架构和可执行载荷会被拒绝。 |
| Filter Store 信任 | 内置和自定义条目都会显示其信任等级。仅凭社区热度绝不会把条目提升为 `verified`。 |
| 扩展代码 | JavaScript、scriptlet 和重定向资源均随经过审查的扩展包提供，绝不会从运行时 URL 加载。 |
| 权限 | 核心过滤权限已有文档说明。只有用户启用相关控制时才会请求 Chrome 的 `privacy` 权限，而且该权限可以撤销。 |
| 本地数据 | 设置、已编译过滤器和存储大小诊断信息保留在设备上，除非用户明确导出。 |
| 发布完整性 | CI 会构建并验证 Chromium 构件；发布包附带 SHA-256 校验和。 |

安全问题应通过 [GitHub Security Advisories](https://github.com/kayurachann/uBlock-Plus/security/advisories/new) 私下报告，而不是提交公开 issue。报告政策请参阅 [SECURITY.md](../SECURITY.md)。

## MV3：功能强大，也如实说明限制

| 当前可用 | 受 MV3 限制 | 未来研究——可选 |
| --- | --- | --- |
| DNR 网络拦截、外观过滤、内置 scriptlet、自定义/导入列表、Filter Store、元素选择器/移除器、可感知上下文的按主机弹出窗口策略、通过观察器执行已打包的 stock `$popup` 规则和受支持的导入 `$popup`/`$popunder` 子集并仅保留经过删减的 realm/源行/类型来源信息，以及备份/恢复 | 实时请求日志、过程式过滤器、异步弹出窗口观察、动态防火墙语义、响应头操作和重定向行为无法提供与 MV2 完全一致的效果 | 托管式企业适配器，以及独立安装的开源原生伴侣程序；均须经过 RFC、用户同意和安全审查 |

受支持的导入弹出窗口过滤器子集现由观察器运行时执行。无法精确表达的条件（例如域类型、请求方法或响应头条件）会被明确延后，而不会近似执行。延后的 `allow` 条件会作为保守的 fail-open 守卫保留；守卫只能延后决策，绝不能近似地放行或拦截。由于执行依赖 MV3 的异步标签页和导航事件，因此并非与 MV2 的同步处理完全等同。动态与会话 DNR 规则共用一个 1,000 条正则规则配额，并非各有 1,000 条。

普通公开 MV3 扩展 API 不提供任意响应正文重写、等效的 DNS/CNAME 可见性或精确的按响应大小拦截。部分 MV2 过滤语法无法转换；在假定功能等效之前，请查阅功能矩阵。弹出窗口匹配仅在本地公开经过删减的 realm、源行和类型来源信息。导入网络列表的编译会记录稳定的接受或延后原因和源代码行号；在控制面板中以更丰富的形式呈现该报告仍属于路线图工作。

## 路线图

<table>
<tr>
<th width="33%">现在</th>
<th width="33%">下一步</th>
<th width="33%">以后</th>
</tr>
<tr>
<td valign="top">

- 强化 Power Edition
- 验证 Filter Store 工作流
- 测试重启与回滚路径
- 建立低内存基准

</td>
<td valign="top">

- 安全的规则去重与分片
- 更丰富的本地诊断
- 改进无障碍体验与国际化
- 公开性能回归报告

</td>
<td valign="top">

- 托管式企业适配器
- 可选原生伴侣程序研究
- 已签名目录的来源证明与撤销机制

</td>
</tr>
</table>

路线图条目不是发布承诺。只有在完成实现、测试、迁移/回滚处理，并通过安全、隐私、许可证和性能审查后，功能才会发布。[查看完整的社区路线图 →](ROADMAP.md)

## 开发与贡献

```bash
npm ci
npm run lint
npm test
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

欢迎通过仓库的结构化 issue 表单提交想法和报告：

- [提出功能建议或报告错误](https://github.com/kayurachann/uBlock-Plus/issues/new/choose)
- [提交 Filter Store 条目](https://github.com/kayurachann/uBlock-Plus/issues/new?template=filter_store_submission.yml)
- [阅读贡献指南](../CONTRIBUTING.md)
- [了解社区治理](COMMUNITY-GOVERNANCE.md)
- [查看模块归属与边界](MODULE-PLAN.md)

本仓库保留上游 Git 历史，并将 [`gorhill/uBlock`](https://github.com/gorhill/uBlock) 配置为仅用于获取的 `upstream` 远程仓库。

## 致谢与许可证

uBlock Plus+ 是基于 [uBlock Origin](https://github.com/gorhill/uBlock) 及从上游继承的 MV3 组件所创作的衍生作品。项目保留版权、源文件头、作者历史和第三方署名。请参阅 [NOTICE.md](../NOTICE.md)。

本项目依据 [GNU 通用公共许可证 v3.0 或更高版本](../LICENSE.txt)发布。

<div align="center">

**开放构建，由用户共同塑造。**

[返回顶部 ↑](#ublock-plus)

</div>
