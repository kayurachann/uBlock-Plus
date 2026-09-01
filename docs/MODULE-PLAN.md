# Kế hoạch module hóa để tiếp nhận yêu cầu cộng đồng

Mục tiêu là thêm feature qua contract hẹp, không biến service worker thành một process sống vĩnh viễn và không để mỗi feature giữ một bản sao filter trong RAM. Các đường dẫn dưới đây là ranh giới logic; thay đổi layout cần decision record nhưng không thay security contract.

## Module map

| Module | Trách nhiệm | Contract chính | Không được làm |
| --- | --- | --- | --- |
| `platform/capabilities` | Probe Chrome version/API/quota/policy | Snapshot capability immutable theo phiên | Giả định sideload = enterprise. |
| `core/settings-state` | Schema, migration, persisted settings | Versioned read/update; last-known-good | Giữ state duy nhất trong global memory. |
| `filter-store/catalog` | Đọc/validate/search catalog đóng gói | Schema v1 và trust tier | Fetch catalog/code tùy ý ở runtime. |
| `filter-compiler/network` | Parse/compile DNR, report unsupported | Deterministic rules + reason codes | Dịch “gần đúng” làm đổi semantics. |
| `filter-compiler/cosmetic` | Cosmetic/procedural data | Site-sharded selector payload | Nhận executable code từ list. |
| `scriptlet-registry` | Packaged scriptlet/redirect capabilities | ID + typed args + allowlist | `eval` hoặc remote scriptlet. |
| `runtime/rule-manager` | Static/dynamic/session IDs, atomic updates | Namespaced plan/apply/rollback | Cắt rule im lặng khi hết quota. |
| `runtime/service-worker` | Orchestration ngắn, alarm/message | Idempotent jobs, resumable state | Permanent timer/background-page pattern. |
| `runtime/content` | DOM/cosmetic/picker bridge | Validated messages, frame scope | Tin DOM/page messages mặc định. |
| `runtime/offscreen-compiler` | DOM-dependent compile tạm thời | Open-job-close lifecycle | Tồn tại chỉ để cache/keepalive. |
| `memory-coordinator` | Resolve profile, cache budget, cleanup, telemetry local | `get/setMemoryProfile`, cleanup API | Tự tắt filter hoặc upload telemetry. |
| `diagnostics` | Redacted local counters/report export | User-triggered snapshot | Full-history collection mặc định. |
| `ui` | Dashboard/popup/store/accessibility/i18n | View-model messages | Truy cập raw storage nội bộ tùy ý. |
| `enterprise-adapter` *(future)* | Managed policy/capability | Explicit managed interface | Hoạt động khi policy probe thất bại. |
| `native-protocol` *(future)* | Versioned Native Messaging IPC | Bounded allowlisted commands | Shell command/general-purpose proxy API. |

## Message và state contract

- Mỗi message có `type`, schema version, payload validate và response/error code ổn định.
- Action nhạy cảm kiểm tra sender/context, không chỉ kiểm tra string `type`.
- Job dài ghi checkpoint; service-worker restart không tạo duplicate rule/update.
- Storage schema có version + forward migration + last-known-good snapshot cho rule plan.
- Module mới không đọc key storage riêng của module khác; dùng accessor/contract.

## Memory contract

- `memoryProfile`: `auto | balanced | low-memory`.
- Không giữ đồng thời raw list, normalized AST và compiled output lâu hơn một phase cần thiết.
- Imported lists compile tuần tự ở low-memory; buffer/chunk có upper bound và hỗ trợ abort.
- Cache dùng byte/entry budget, LRU hoặc lifecycle rõ; orphan cache được cleanup.
- Offscreen document đóng sau job; service worker không có keepalive giả.
- Mọi cache mới phải có owner, key schema, invalidation, size estimate và test cleanup.
- PR tác động runtime báo peak/median/p95 so với stable baseline; telemetry chỉ ở local diagnostics.

## Extension points an toàn

Được khuyến khích:

- thêm catalog metadata theo schema;
- thêm filter parser/operator có grammar, capability mapping và negative tests;
- thêm packaged scriptlet qua registry và security review;
- thêm UI panel dùng message contract và i18n;
- thêm diagnostic counter không chứa browsing data lâu dài.

Không chấp nhận:

- tải module/scriptlet từ Git repo, CDN hoặc filter URL;
- hook tùy ý vào mọi request/message;
- singleton cache không giới hạn;
- permission mới chỉ để “có thể dùng sau”;
- native IPC kiểu chạy command/string shell.

## Checklist nhận feature cộng đồng

1. **Problem:** ai gặp, workflow và reproduction là gì?
2. **Capability:** Power MV3 làm được đầy đủ/một phần/không; có cần enterprise/native không?
3. **Boundary:** module owner, input/output, state, permission, trust boundary.
4. **Resource:** DNR rule/regex, storage, memory peak, CPU/wake-up và network cost.
5. **Failure:** quota, malformed input, service-worker eviction, rollback và user-visible error.
6. **Safety:** threat model, privacy, remote-code, filter trust và license.
7. **Quality:** unit/integration/browser test, low-memory benchmark, docs/i18n/accessibility.

Nếu đề xuất không vừa module hiện có, tác giả viết RFC cho contract mới thay vì import chéo nội bộ.

## Test pyramid

- Unit: parser, schema, priority, migration, message validation, memory profile resolution.
- Property/fuzz: hostile filter text, Unicode, regex, catalog JSON và deterministic compile.
- Integration: catalog → import → compile → rule apply/rollback; cache cleanup; restart giữa job.
- Browser: request/cosmetic behavior, incognito boundaries, permission flow, service-worker eviction.
- Performance: 4 GiB-class/8 GiB-class profiles, cold start, idle, compile peak, large catalog và quota edge.
- Supply chain: clean build, lockfile, artifact diff/checksum/provenance.

## Ownership và upstream sync

Core compiler/scriptlet changes cần reviewer hiểu upstream để giảm divergence. Community feature nên ở adapter/module riêng khi có thể, nhưng không copy nguyên core chỉ để tránh conflict. Merge upstream giữ source header, copyright, commit attribution và GPL-3.0-or-later; fork không sử dụng official signing identity/release channel của uBlock Origin.
