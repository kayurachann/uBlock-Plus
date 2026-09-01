<div align="center">

<img src="assets/readme/hero.png" alt="Chromium 페이지가 로드되기 전에 방패가 광고, 추적기, 쿠키와 그 밖의 원치 않는 웹 요청을 필터링하는 그림" width="1100">

<sub>콘셉트 일러스트 · v1.0.0은 수동으로 업데이트하는 사이드로드용 사전 릴리스입니다</sub>

# uBlock Plus+

### 커뮤니티가 함께 만드는 Chromium Manifest V3용 콘텐츠 차단기

**사이드로드 우선 · 로컬 우선 · 오픈 소스 · 사용자 제어 중심**

[![MV3 Chromium CI](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml/badge.svg)](https://github.com/kayurachann/uBlock-Plus/actions/workflows/mv3-chromium.yml)
[![Latest release](https://img.shields.io/github/v/release/kayurachann/uBlock-Plus?include_prereleases&label=pre--release&color=3b82f6)](https://github.com/kayurachann/uBlock-Plus/releases)
[![Chromium 130+](https://img.shields.io/badge/Chromium-130%2B-4285F4?logo=googlechrome&logoColor=white)](#quick-start)
[![Manifest V3](https://img.shields.io/badge/Manifest-V3-8b5cf6)](ARCHITECTURE.md)
[![GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-22c55e)](../LICENSE.txt)

[English](../README.md) · [Deutsch](README.de.md) · [Español](README.es.md) · [Français](README.fr.md) · [日本語](README.ja.md) · [**한국어**](README.ko.md) · [Русский](README.ru.md) · [Tiếng Việt](README.vi.md) · [简体中文](README.zh_CN.md) · [繁體中文](README.zh_TW.md)

[**최신 미리보기 다운로드**](https://github.com/kayurachann/uBlock-Plus/releases) · [기능 표](FEATURE-MATRIX.md) · [아키텍처](ARCHITECTURE.md) · [Filter Store](FILTER-STORE.md) · [로드맵](ROADMAP.md)

</div>

---

uBlock Plus+는 Chromium MV3용으로 독립 개발되는 GPL 라이선스 콘텐츠 차단기입니다. 검증된 업스트림 필터링/컴파일러 기반에 커뮤니티 Filter Store, 이동 가능한 설정, 명시적인 고급 사용자 제어, 메모리를 고려한 동작을 결합합니다. 프로젝트가 운영하는 텔레메트리 서비스나 원격 실행 코드는 사용하지 않습니다.

> [!IMPORTANT]
> **릴리스 상태:** v1.0.0은 수동 사이드로드용 사전 릴리스이며 자동으로 업데이트되지 않습니다. uBlock Plus+는 uBlock Origin 또는 uBO Lite의 공식 릴리스가 아니며 Raymond Hill의 보증을 받지 않았습니다. Chrome MV3는 기존 MV2 확장 프로그램에서 사용할 수 있던 모든 차단 기능을 제공하지 않습니다. 사이드로드는 Chrome 웹 스토어의 배포 정책을 피할 수 있지만 DNR 할당량, 서비스 워커 수명 주기 규칙 또는 브라우저 보안 경계를 없애지는 **않습니다**. [솔직한 호환성 표](FEATURE-MATRIX.md)를 확인하세요.

## 사용자의 선택을 중심으로

<table>
<tr>
<td width="50%" valign="top">

### 🛡️ 다층 콘텐츠 차단

정적, 동적, 세션 DNR 규칙이 코스메틱 필터링, 패키지에 포함된 스크립틀릿, 엄격한 차단, 상황 인식형 Smart Popup Blocker와 함께 작동합니다.

</td>
<td width="50%" valign="top">

### 🧩 커뮤니티 Filter Store

패키지에 포함된 커뮤니티 카탈로그를 살펴보거나 호환되는 HTTPS 저장소를 최대 8개까지 추가할 수 있습니다. 모든 원격 목록은 실행 가능한 확장 프로그램 코드가 아니라 필터 **데이터**로만 취급됩니다.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 사이트별 제어

사이트별 필터링 모드를 선택하고, 일치한 규칙 진단을 확인하며, 페이지를 직접 다듬어야 할 때 요소 선택기, 제거 도구 또는 선택 해제 도구를 사용할 수 있습니다.

</td>
<td width="50%" valign="top">

### 🌱 메모리를 고려한 프로필

`auto`, `balanced`, `low-memory` 중에서 선택할 수 있습니다. Low-memory 모드는 순차 컴파일, 제한된 캐시, 안전한 정리를 사용하며 활성화된 필터를 몰래 끄지 않습니다.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📦 옮겨 다닐 수 있는 설정

핵심 설정, 구독, 저장소, 팝업 정책, 사용자 지정 필터를 내보내고 복원할 수 있습니다. 기본 카탈로그는 출발점일 뿐 사용자를 가두는 장치가 아닙니다.

</td>
<td width="50%" valign="top">

### 🔐 개인정보 보호를 고려한 설계

필터링 및 저장소 진단은 로컬에 남습니다. 프로젝트 분석 계정, 광고 SDK 또는 방문 기록 서비스가 없습니다. Chrome 개인정보 보호 제어에는 별도의 취소 가능한 권한이 필요합니다.

</td>
</tr>
</table>

Power UI의 전체 문자열은 영어, 독일어, 스페인어, 프랑스어, 일본어, 한국어, 러시아어, 베트남어, 중국어 간체, 중국어 번체로 번역되어 있습니다. 패키지에 포함된 나머지 61개 로캘에는 빌드 시 결정되는 영어 대체 문자열이 적용되므로, 커뮤니티 번역이 완성되기 전에도 새 컨트롤이 빈칸으로 표시되지 않습니다.

<div align="center">

[모든 기능 살펴보기 →](FEATURE-MATRIX.md)

</div>

## 실제 동작 화면

<sub>개인 방문 기록이 없는 새 Edge 프로필에서 압축을 푼 v1.0.0 아티팩트를 캡처했습니다</sub>

<table>
<tr>
<td width="62%" valign="top">

<img src="assets/readme/filter-store.png" alt="DNR 할당량 추정치, 세 개의 번들, 첫 번째 커뮤니티 필터 카드를 보여 주는 실제 uBlock Plus+ Filter Store">

<strong>Filter Store</strong><br>
커뮤니티 항목을 살펴보고 할당량 영향을 확인한 뒤 용도별 번들을 명시적으로 활성화할 수 있습니다.

</td>
<td width="38%" valign="top">

<img src="assets/readme/memory-settings.png" alt="Auto 모드, 실제 적용된 Balanced 설정, 로컬 저장소 진단을 보여 주는 실제 uBlock Plus+ Memory Profile 설정">

<strong>Memory Profile</strong><br>
Auto, Balanced 또는 Low-memory를 선택하고 실시간 RAM이 아닌 로컬 캐시/저장소 지표를 확인할 수 있습니다.

</td>
</tr>
</table>

<a id="quick-start"></a>

## 빠른 시작

<div align="center">

<img src="assets/readme/install-flow.svg" alt="다운로드 및 압축 해제, SHA-256 검증, 압축 해제된 확장 프로그램 로드, 표시되는 경우 사용자 스크립트 허용의 네 단계" width="1100">

</div>

### 릴리스 설치

1. [GitHub Releases](https://github.com/kayurachann/uBlock-Plus/releases)에서 `uBlock-Plus_*.chromium.zip`과 일치하는 `.sha256` 파일을 다운로드합니다.
2. 체크섬을 검증한 다음 ZIP을 계속 유지할 폴더에 압축 해제합니다.
3. `chrome://extensions` 또는 `edge://extensions`를 엽니다.
4. **개발자 모드**를 켜고 **압축 해제된 확장 프로그램을 로드합니다**를 선택한 다음 `manifest.json`이 들어 있는 압축 해제 폴더를 지정합니다.
5. Chrome 138 이상에서는 확장 프로그램의 **세부정보** 페이지를 열고 **사용자 스크립트 허용**을 켭니다. Chrome 130–137에서는 대신 전역 **개발자 모드** 스위치를 사용합니다. 설치 후 어느 스위치든 변경했다면 확장 프로그램 카드에서 **새로고침**을 눌러 서비스 워커 컨텍스트가 새 API 상태를 인식하도록 하세요. 그러면 지원되는 가져온 코스메틱 필터와 패키지 허용 목록에 포함된 스크립틀릿을 등록할 수 있습니다. Chrome의 [`userScripts` 안내](https://developer.chrome.com/docs/extensions/reference/api/userScripts)를 참고하세요.

> [!NOTE]
> 사이드로드한 확장 프로그램은 Chrome 웹 스토어를 통해 업데이트되지 않습니다. [Releases](https://github.com/kayurachann/uBlock-Plus/releases)를 확인하고 새 버전이 게시되면 압축을 푼 빌드를 교체하세요. 이 저장소의 아티팩트만 설치하고 제공된 SHA-256 체크섬을 검증하세요.

<details>
<summary><strong>Windows에서 릴리스 체크섬 검증</strong></summary>

```powershell
(Get-FileHash .\uBlock-Plus_1.0.0.chromium.zip -Algorithm SHA256).Hash
Get-Content .\uBlock-Plus_1.0.0.chromium.zip.sha256
```

16진수 해시가 일치해야 합니다(대소문자는 구분하지 않습니다).

</details>

### 소스에서 빌드

요구 사항: Chrome/Chromium 또는 Edge 130 이상, 하위 모듈을 지원하는 Git, Node.js 22 이상, 빌드 시 필터 데이터를 받기 위한 네트워크 연결.

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

# 선택 사항: 버전이 표시된 ZIP과 SHA-256 파일도 만듭니다.
VERSION=$(node -p "require('./package.json').version")
tools/make-mv3.sh chromium "$VERSION"
```

</details>

브라우저의 확장 프로그램 페이지에서 `dist/build/uBlockPlus.chromium`을 로드하세요. 버전을 지정한 PowerShell 명령과 선택적인 버전 지정 셸 명령은 `dist/build/` 아래에 ZIP과 체크섬을 만듭니다. 일반 `make mv3-chromium`은 압축을 풀어 놓은 디렉터리만 만듭니다.

## 작동 방식

<div align="center">

<img src="assets/readme/feature-map.svg" alt="사용자가 선택한 소스에서 검증된 컴파일을 거쳐 Chromium의 DNR 및 코스메틱 필터링으로 이어지는 필터링 흐름" width="1100">

</div>

- Chrome DNR은 요청마다 서비스 워커를 깨우지 않고 네트워크 필터링을 처리합니다.
- 이벤트 기반 서비스 워커는 설정, 카탈로그 상태, 마이그레이션, 복구 가능한 규칙 업데이트를 관리합니다.
- 가져온 목록은 로컬에서 DNR 및 코스메틱 데이터로 컴파일됩니다. 스크립틀릿은 이미 패키지 허용 목록에 있어야 합니다.
- 오프스크린 컴파일은 일시적으로만 실행되며 작업이 끝나면 닫힙니다.

[아키텍처 읽기](ARCHITECTURE.md) · [Power Runtime 살펴보기](POWER-RUNTIME.md) · [위협 모델 검토](THREAT-MODEL.md) · [개인정보 보호 이해하기](PRIVACY.md)

## 보안 및 신뢰 경계

| 경계 | 프로젝트 규칙 |
| --- | --- |
| 원격 소스 | HTTPS 카탈로그와 목록은 크기가 제한된 데이터로 파싱되며 리디렉션, 잘못된 스키마, 실행 가능한 페이로드는 거부됩니다. |
| Filter Store 신뢰 | 기본 및 사용자 지정 항목에는 신뢰 등급이 표시됩니다. 커뮤니티 인기도만으로 항목이 `verified`로 승격되지는 않습니다. |
| 확장 프로그램 코드 | JavaScript, 스크립틀릿, 리디렉션 리소스는 검토된 확장 프로그램 패키지 안에 포함되며 런타임 URL에서 가져오지 않습니다. |
| 권한 | 핵심 필터링 권한은 문서화되어 있습니다. Chrome의 `privacy` 권한은 사용자가 해당 제어 기능을 켤 때만 요청되며 취소할 수 있습니다. |
| 로컬 데이터 | 설정, 컴파일된 필터, 저장소 크기 진단은 사용자가 명시적으로 내보내지 않는 한 기기에 남습니다. |
| 릴리스 무결성 | CI가 Chromium 아티팩트를 빌드하고 검증하며 릴리스에는 SHA-256 체크섬이 포함됩니다. |

보안 문제는 공개 이슈가 아니라 [GitHub Security Advisories](https://github.com/kayurachann/uBlock-Plus/security/advisories/new)를 통해 비공개로 신고하세요. 신고 정책은 [SECURITY.md](../SECURITY.md)를 참고하세요.

## 강력하지만 한계가 분명한 MV3

| 현재 사용 가능 | MV3로 인한 제약 | 향후 연구—선택 사항 |
| --- | --- | --- |
| DNR 네트워크 차단, 코스메틱 필터링, 패키지 스크립틀릿, 사용자 지정/가져온 목록, Filter Store, 선택기/제거 도구, 상황 인식형 호스트별 팝업 정책, 백업/복원 | 실시간 요청 로깅, 절차형 필터, 가져온 팝업 필터 적용, 동적 방화벽 의미 체계, 응답 헤더 작업, 리디렉션 동작은 MV2와 부분적으로만 동등합니다 | RFC, 동의, 보안 검토를 전제로 하는 Managed Enterprise 어댑터와 별도로 설치하는 오픈 소스 네이티브 컴패니언 |

임의 응답 본문 재작성, 동등한 DNS/CNAME 가시성, 응답 크기에 따른 정확한 차단은 일반 공개 MV3 확장 API로 사용할 수 없습니다. 일부 MV2 필터 구문은 변환할 수 없으므로 동등하다고 가정하기 전에 기능 표를 확인하세요. 가져온 네트워크 목록 컴파일은 이제 안정적인 거부 사유와 소스 줄 번호를 기록하지만, 그 보고서를 대시보드에서 더 자세히 보여 주는 기능은 아직 로드맵 과제입니다.

## 로드맵

<table>
<tr>
<th width="33%">현재</th>
<th width="33%">다음</th>
<th width="33%">나중</th>
</tr>
<tr>
<td valign="top">

- Power Edition 강화
- Filter Store 워크플로 검증
- 재시작 및 롤백 경로 점검
- Low-memory 기준선 수립

</td>
<td valign="top">

- 안전한 규칙 중복 제거 및 샤딩
- 더 풍부한 로컬 진단
- 접근성 및 국제화 다듬기
- 공개 성능 회귀 보고서

</td>
<td valign="top">

- Managed Enterprise 어댑터
- 선택형 네이티브 컴패니언 연구
- 서명된 카탈로그 출처 및 취소

</td>
</tr>
</table>

로드맵 항목은 릴리스 약속이 아닙니다. 기능은 구현, 테스트, 마이그레이션/롤백 처리와 보안, 개인정보 보호, 라이선스, 성능 검토를 마친 뒤에만 출시됩니다. [전체 커뮤니티 로드맵 보기 →](ROADMAP.md)

## 개발 및 기여

```bash
npm ci
npm run lint
npm test
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium --release
```

아이디어와 보고는 저장소의 정형화된 이슈 양식을 통해 보내 주세요.

- [기능 제안 또는 버그 신고](https://github.com/kayurachann/uBlock-Plus/issues/new/choose)
- [Filter Store 항목 제출](https://github.com/kayurachann/uBlock-Plus/issues/new?template=filter_store_submission.yml)
- [기여 가이드 읽기](../CONTRIBUTING.md)
- [커뮤니티 거버넌스 이해하기](COMMUNITY-GOVERNANCE.md)
- [모듈 소유권과 경계 검토](MODULE-PLAN.md)

이 저장소는 업스트림 Git 기록을 보존하며 [`gorhill/uBlock`](https://github.com/gorhill/uBlock)을 가져오기 전용 `upstream` 원격 저장소로 유지합니다.

## 크레딧 및 라이선스

uBlock Plus+는 [uBlock Origin](https://github.com/gorhill/uBlock)과 그 MV3/uBO Lite 구현을 기반으로 한 파생 저작물입니다. 저작권, 소스 헤더, 작성자 기록, 제3자 저작자 표시는 보존됩니다. [NOTICE.md](../NOTICE.md)를 참고하세요.

[GNU General Public License v3.0 이상](../LICENSE.txt)에 따라 배포됩니다.

<div align="center">

**열린 방식으로 만들고, 사용자가 함께 다듬습니다.**

[맨 위로 ↑](#ublock-plus)

</div>
