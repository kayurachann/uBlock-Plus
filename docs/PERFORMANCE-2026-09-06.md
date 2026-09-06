# Performance and quality review — 6 September 2026

This review compares the fork with **full uBlock Origin**, AdGuard's extension engine and Ghostery's blocker tooling. Its purpose is to reduce repeated work and peak allocations on modest hardware while preserving the user's enabled filters, exceptions and documented MV3 fail-open behavior. It is not a claim that the fork outperforms these projects.

## Choosing settings on a low-resource computer

Open **Dashboard → Settings → Memory profile**. Start with **Auto**, or select **Low memory** explicitly when the browser's hardware hint is unavailable or the computer is under memory pressure.

| Memory profile | How it is selected | Runtime policy |
| --- | --- | --- |
| Auto | Uses Low memory when the browser reports a positive coarse memory hint of 4 GiB or less; otherwise Balanced. A saved hint can be reused when a restarted worker does not expose the API. | Uses the effective profile shown in Settings. |
| Balanced | Explicit selection, independent of the hardware hint. | Compilation concurrency of 2; CSS result-cache target of 256 entries, pruning threshold of 288; scripting registration metadata may be retained. |
| Low memory | Explicit selection, or selected by Auto. | Compilation concurrency of 1; CSS result-cache target of 64 entries, pruning threshold of 72; scripting registration metadata is released after use. |

The browser hint is coarse and is **not a measurement of free RAM**. Cache targets are pruning targets, not an absolute instantaneous bound: concurrent frames can temporarily create additional entries. Smaller caches can require more recomputation when revisiting many sites.

**Memory profile and Protection preset are different controls.** A memory profile changes resource budgets without disabling enabled filter lists or reducing the selected filtering level. A Protection preset applies a group of filtering and runtime preferences; review its resulting settings before using it. Keep the existing protection selection when only changing resource budgets.

Leave the filtering logger off when it is not needed for diagnosis. Let the normal update schedule and caches do their work; repeatedly clearing caches or forcing list updates creates more compilation work. Select additional lists for a concrete need, since overlapping lists can add work and increase breakage risk. No list is silently disabled to improve the measurements in this review.

Full uBO documents that disabling generic cosmetic filtering can reduce overhead on large, long-lived pages, but can substantially impair lists which depend on it, including some cookie-notice lists. That is a separate user-visible tradeoff, not an automatic consequence of this fork's Low memory profile. [uBO filter-list settings](https://github.com/gorhill/uBlock/wiki/Dashboard%3A-Filter-lists).

## What the upstream projects teach

Status and source content were checked on 6 September 2026. A closed upstream issue supplies a regression scenario; it does not establish that this fork has the same defect.

| Primary source | Verified finding | Application to this fork |
| --- | --- | --- |
| [Full uBO dynamic firewall source](https://github.com/gorhill/uBlock/blob/master/src/js/dynamic-net-filtering.js) | Uses source/destination lookup and hostname decomposition with explicit precedence, rather than sorting the full rule set for each request. | A possible later optimization for the Experimental firewall. Preserve destination/source/type precedence and allow/noop semantics in any replacement. |
| [Full uBO compiled-cache design](https://github.com/gorhill/uBlock/wiki/Launch-and-filter-lists-load-performance) | Reusing compiled lists avoids repeating costly raw-filter parsing. | Preserve valid compiled generations and measure cold and warm workloads separately. Do not treat cache deletion as a general performance improvement. |
| [AdGuard TSWebExtension changelog](https://github.com/AdguardTeam/tsurlfilter/blob/master/packages/tswebextension/CHANGELOG.md) | The 17 April 2026 beta introduced lazy loading and unloading of heavy metadata. Version 5.0.0, dated 28 July, retained `badFilterRules` and `rulesHashMap` after `configure()` again because subsequent configurations could otherwise receive empty metadata from cached rulesets. Lazy reloading is tracked upstream as AG-53262. | Release data only when it can be reconstructed reliably. Reconfiguration, `$badfilter`, exceptions, restart and rollback must remain correct. The April change is not evidence that every metadata cache should be cleared. |
| [AdGuard #3537](https://github.com/AdguardTeam/AdguardBrowserExtension/issues/3537) | Closed, marked Fixed for v5.5. Reports intermittent missing cosmetic and scriptlet application after fast navigation in MV3. | Test actual DOM results after rapid reload, mode changes and frame navigation, including exceptions. |
| [AdGuard #3547](https://github.com/AdguardTeam/AdguardBrowserExtension/issues/3547) | Closed, marked Done for v5.5 and labeled MV2. Reports an extension running out of memory during repeated page refreshes. | Use repeated navigation as a memory stress workload. Do not present this as an unresolved MV3 defect or as a reproduced leak in this fork. |
| [Ghostery benchmark runner](https://github.com/ghostery/adblocker/blob/master/bench/run_benchmark.ts) | Separates engine creation, serialization/deserialization and parsing/lookup measurements, records sample counts and error margins, and distinguishes engine memory from serialized bytes. | Report workload-specific measurements and reproducible inputs. A smaller ZIP or storage cache is not proof of lower live RAM. |

No upstream engine or dependency was added solely to obtain more features. A second engine can duplicate dictionaries and initialization work; any such integration needs its own compatibility, lifecycle and resource measurements.

## Implemented changes

These changes apply to both the standard and Experimental packages.

1. **Reuse the worker's resolved memory profile.** Avoid repeated storage reads for an unchanged hardware hint/profile, and coalesce initialization work. Profile writes and cache publication must preserve durable state when an operation fails.
2. **Bound per-frame cosmetic dictionary loading.** An uncached frame previously requested all relevant stock cosmetic dictionaries concurrently. Load them in bounded batches according to the resource policy, while accumulating the complete selector and exception sets before injection. A cache hit should continue to avoid reading those dictionaries.
3. **Keep incomplete cosmetic results out of the page and cache.** If a dictionary cannot be read, it could contain an exception to another list. The lookup now fails open without caching a partial result, so another navigation can retry. Missing Off scopes or a mode change during dictionary loading also cancel the lookup. An already trusted page skips dictionary reads.

These changes target repeated I/O and temporary allocations. They do not raise DNR quotas, remove browser restrictions, disable filters, or change the Experimental firewall's permission requirements. They must retain Off, child exceptions, cross-list exceptions and existing fail-open decisions. A longer cold-cache cosmetic load is a possible tradeoff of lower concurrency and must be reported if observed.

## Measurement method

Use the same installed Chrome executable, selected lists, local HTTP fixtures and machine for the baseline and candidate. Record the commit, package/tree hashes, Chrome and Node versions, memory profile and enabled filtering modes. Use separate short-path test profiles; do not change the user's everyday Chrome profile. Keep the sandbox and ordinary browser protections enabled.

| Workload | What to record | Correctness condition |
| --- | --- | --- |
| Repeated memory-profile reads | Storage reads/writes, elapsed time, concurrent initialization behavior. | Same resolved profile; explicit selection and saved hint survive restart; failed writes do not publish an uncommitted selection. |
| Cosmetic cache miss | Concurrent dictionary reads, elapsed time, sampled page/worker heap where available. | All expected selectors and exceptions are applied, including exceptions appearing in a later dictionary. |
| Cosmetic cache hit | Dictionary reads and elapsed time on a repeated visit. | Same DOM result; no unnecessary full-dictionary read. |
| Multiple frames and repeated navigation | Frame count, iterations, errors and memory over time. | Filtering persists after reload; Off and exceptions remain effective. |
| Configuration and worker lifecycle | Mode/profile changes and worker stop/wake. | Correct active state is recovered without stale policy or silently lost rules. |

Run correctness checks independently of timing measurements. Keep browser-level fixture results separate from isolated JavaScript microbenchmarks. Report the number of runs and the statistic used; retain outliers or explain exclusions. For memory, identify the exact metric and sampling method. A sampled JavaScript heap is not total Chrome resident memory, and a retained heap after garbage collection is not the allocation peak.

Resource diagnostics in Settings report extension **storage** usage. They are not live RAM measurements. CPU throttling, if used, is a synthetic stress condition rather than a substitute for testing a physical 2–4 GiB computer. Do not claim support for every weak computer from a single development machine.

## Results for this pass

Measured on installed **Google Chrome 152.0.7977.76**, Windows, AMD Ryzen 5 5600H (6 cores/12 threads), with 7,928,262,656 bytes of OS-visible physical memory. Release tools used Node **22.22.0** and npm **11.19.1**. No CPU throttle was applied. This is not a physical 2–4 GiB hardware test.

The native microbenchmark uses 13 synthetic dictionaries (12 selector dictionaries and a final exception dictionary), totaling **3,556,774 serialized JSON bytes**. It executes the packaged cosmetic code in Chrome's extension isolated world against native storage and checks the actual DOM. Native stock registration is disabled on this fixture to isolate the workload; this does not benchmark complete page loading or the full filter corpus. Storage API wrappers count calls and forward them to Chrome without substituting responses.

The final baseline/candidate runs were sequential with no concurrent build. An earlier exploratory candidate run overlapped package building and is excluded from timing comparisons. All samples of the final pair, including retained heap measurements, are in [the raw result data](benchmarks/performance-2026-09-06.json).

| Native workload | Baseline | Candidate |
| --- | --- | --- |
| 200 repeated profile requests, median of 5 batches, including message round trips | 114.5 ms; 200 local storage reads per batch | 75.5 ms; 0 local storage reads per batch |
| Low-memory: peak concurrent dictionary reads per frame | 13 | 1 |
| Balanced: peak concurrent dictionary reads per frame | 13 | 2 |
| Low-memory cold cosmetic lookup, median of 3 samples | 40.0 ms | 52.9 ms |
| Balanced cold cosmetic lookup, median of 3 samples | 35.0 ms | 41.7 ms |
| Warm lookup: dictionary reads, one sample per profile | 0 | 0 |
| Off page: dictionary reads, one sample per profile | 13 | 0 |
| DOM checks after cold/warm/re-enabled lookup | 11 hidden; final-list exception stays visible | Same |

Lower concurrency costs about 13 ms in the measured Low-memory cold lookup and about 7 ms in Balanced. This is a resource-budget tradeoff, not a general page-speed improvement. The warm samples were 3.9/4.1 ms before and 3.1/3.2 ms after (Low-memory/Balanced); one sample each is insufficient for a speed claim.

`Runtime.getHeapUsage` after explicit `HeapProfiler.collectGarbage` reported roughly **2.0 MB retained page JavaScript heap for both builds** (candidate about 56 bytes higher). This is neither peak allocation nor Chrome process RSS. The benchmark demonstrates fewer concurrent deserializations and fewer storage calls; it does **not** demonstrate a percentage reduction in total live RAM.

| Evidence | Result |
| --- | --- |
| Baseline | Source `9cf901dd1f859ef328192d60a9c504bdcde53ff5`; standard ZIP SHA256 `ff4e4951339aaca86b7d852e85aca010ba3a770db087e6951650b6c994075ef5` |
| Candidate standard | ZIP SHA256 `437f9116a0dfdc6b06943caf95749a1a0b3c1762fe1e6adec85e16a6201543ab`; 1,114 entries byte-verified |
| Candidate Experimental | ZIP SHA256 `a6aa3a76fbbd90718156921cdfc156fd3cca95fde8064349dc8a3c5aeb1b7f3f`; 1,117 entries byte-verified |
| Unit/regression suite | 44 test programs pass, including 10,500 full-uBO firewall differential cases and new concurrent-read, write-failure, missing-dictionary and mode-change cancellation regressions |
| Release pipeline | `npm ci`, `npm test`, `npm run lint`, both builds and both release validators pass; `npm audit`: zero vulnerabilities; Windows PowerShell 5.1 launcher dry run passes |
| Native cosmetic timing fixtures | 12 scenarios per build pass: three cold visits, warm visit, Off and re-enable, for each profile |
| Native cosmetic failure/frame checks | 5 checks pass: missing exception dictionary, restored dictionary on the same document, Off during an awaited native read, and both frames of a concurrent same-origin fixture |
| Native Experimental firewall | 24 checks pass across ordinary and allowlisted Chrome launches, including DNR fallback, Off, allow/noop, tabless fail-open, worker restart and tab-context hydration |

Reproduce with the same harness on a saved baseline and a rebuilt candidate. All path arguments must be absolute:

```powershell
node tools/test-memory-performance-chrome.mjs `
  --extension 'C:\path\to\unpacked-extension' `
  --chrome 'C:\Program Files\Google\Chrome\Application\chrome.exe' `
  --playwright 'C:\path\to\playwright-core\index.mjs' `
  --output 'C:\path\to\benchmark-report'
```

Add `--verify-fail-open` when testing the candidate to run the native missing-dictionary, retry, mode-change and frame assertions. Those quality runs are excluded from the timing comparison. This optional native harness requires a local Playwright Core installation; it adds no production dependency. The ordinary CI pipeline runs the deterministic source regressions. Private raw working reports are under `tmp/performance-2026-09-06/`; the committed result file omits local user/profile paths and retains browser version, source hashes, fixture size and every timing sample.

## Remaining work

- Validate on physical machines with 2–4 GiB RAM, including longer browsing sessions and memory pressure from other applications.
- Profile stock dictionary re-registration and CSS-cache pruning before changing their invalidation or scheduling behavior.
- Evaluate an indexed Experimental firewall with differential precedence tests and a request workload; this is separate from the changes above.
- Expand automated browser coverage for scriptlet ordering and rapid cross-origin frame changes. Performance improvements do not establish full uBO compatibility.

## Tóm tắt tiếng Việt

Để tiết kiệm tài nguyên mà giữ bộ lọc đang bật, vào **Cài đặt → Cấu hình bộ nhớ**, dùng **Tự động** hoặc **Ít bộ nhớ**. Đây là cấu hình tài nguyên, khác với preset bảo vệ. Đợt này tập trung giảm đọc storage lặp trong worker và giới hạn số dictionary cosmetic được nạp đồng thời ở từng frame; không tự tắt bộ lọc để có số đo đẹp.

Nghiên cứu cũng cập nhật một điểm quan trọng: AdGuard đã phải thay đổi lại tối ưu giải phóng metadata vì ảnh hưởng lần cấu hình tiếp theo. Trên Chrome thật, lượt đọc cấu hình lặp đã bỏ được 1.000 lần đọc storage trong 5 mẫu đo; số dictionary nạp đồng thời giảm từ 13 xuống 1/2. Low-memory mất thêm khoảng 13 ms cho lượt cosmetic chưa có cache trong fixture này. Không tuyên bố tỷ lệ giảm RAM: heap giữ lại sau GC gần như bằng nhau và chưa đo trên máy vật lý 2–4 GiB.
