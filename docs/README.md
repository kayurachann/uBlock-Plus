# uBlock Plus+ documentation

This directory contains the user, architecture, security and community documentation for the uBlock Plus+ fork. The canonical project README is [English](../README.md); translated README files live beside this index.

> [!NOTE]
> The detailed English and Vietnamese guides were refreshed on 6 September 2026 with actual Chrome screenshots and current installation/testing guidance. The eight other README translations retain their earlier content and link to the current guides while awaiting a full refresh. Deeper architecture, security and governance documents are not translated into every language. README freshness and extension UI translation coverage are separate.

## README languages

| Language | File |
| --- | --- |
| English | [README.md](../README.md) — current detailed guide |
| Deutsch | [README.de.md](README.de.md) |
| Español | [README.es.md](README.es.md) |
| Français | [README.fr.md](README.fr.md) |
| 日本語 | [README.ja.md](README.ja.md) |
| 한국어 | [README.ko.md](README.ko.md) |
| Русский | [README.ru.md](README.ru.md) |
| Tiếng Việt | [README.vi.md](README.vi.md) — hướng dẫn chi tiết hiện tại |
| 简体中文 | [README.zh_CN.md](README.zh_CN.md) |
| 繁體中文 | [README.zh_TW.md](README.zh_TW.md) |

## Project documentation

| Document | Scope |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | MV3 pipeline, compiled popup routes, durable state, memory profiles and capability layers. |
| [PERFORMANCE-2026-09-06.md](PERFORMANCE-2026-09-06.md) | Full uBO/AdGuard/Ghostery research, memory profiles, native Chrome before/after measurements, correctness and tradeoffs. |
| [FEATURE-MATRIX.md](FEATURE-MATRIX.md) | Honest comparison between original MV2 behavior and current MV3 support. |
| [EXPERIMENTAL-WEBREQUEST.md](EXPERIMENTAL-WEBREQUEST.md) | Optional synchronous firewall, separate Chrome launcher/profile, actual permission detection and DNR fallback. |
| [BRANDING.md](BRANDING.md) | Yellow-plus logo, source SVG, icon states and rendering. |
| [USERSCRIPTS-AND-MV3-2026-09-06.md](USERSCRIPTS-AND-MV3-2026-09-06.md) | Userscript boundaries, managed-engine research, upstream issues and new regression evidence. |
| [MV3-CAPABILITY-AUDIT-2026-09-06.md](MV3-CAPABILITY-AUDIT-2026-09-06.md) | Vietnamese audit against full uBlock Origin, reproduced defects and improvements informed by AdGuard/Brave. |
| [MV3-PARITY-IMPLEMENTATION-2026-09-06.md](MV3-PARITY-IMPLEMENTATION-2026-09-06.md) | Implemented firewall, unified logger, cross-source exceptions, exact cancellation and remaining Chrome API boundaries. |
| [MV3-POPUP-PARITY.md](MV3-POPUP-PARITY.md) | Site power, filtering levels, popup policy and scope/recovery guarantees. |
| [MV3-CHROME-RETEST-2026-09-06.md](MV3-CHROME-RETEST-2026-09-06.md) | Dated local release validation and 28 + 7 scenarios on installed Google Chrome. |
| [MV3-RETEST-2026-09-05.md](MV3-RETEST-2026-09-05.md) | Upstream issue comparisons and durability/fail-open regression coverage. |
| [README screenshot provenance](assets/readme/README.md) | Actual Chrome image sources, build hashes, capture settings and older illustrations. |
| [POWER-RUNTIME.md](POWER-RUNTIME.md) | DNR quota accounting, service-worker lifecycle, popup runtime and optional-tier boundaries. |
| [FILTER-STORE.md](FILTER-STORE.md) | Catalog schema, repositories, trust tiers and review workflow. |
| [PRIVACY.md](PRIVACY.md) | Local data, network access, permissions and retention. |
| [THREAT-MODEL.md](THREAT-MODEL.md) | Assets, trust boundaries and supply-chain threats. |
| [ROADMAP.md](ROADMAP.md) | Current, next and research work without release-date promises. |
| [COMMUNITY-RESEARCH.md](COMMUNITY-RESEARCH.md) | Dated Chrome/Chromium and upstream uBO/uAssets evidence behind capability limits and priorities. |
| [COMMUNITY-GOVERNANCE.md](COMMUNITY-GOVERNANCE.md) | RFCs, roles and community decision-making. |
| [MODULE-PLAN.md](MODULE-PLAN.md) | Module ownership and implementation boundaries. |

Translations should preserve security warnings, MV3 limitations, install steps and relative asset links. English remains the source of truth when translated wording differs.
