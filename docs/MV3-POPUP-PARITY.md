# uBlock Origin-style controls on MV3

This implementation uses the bundled uBlock Origin popup as its interaction reference while retaining the fork's MV3 engine and identity. The popup centers the site power button, exposes the supported filtering levels and popup policies, and provides keyboard-accessible picker, zapper, filter-editor and dashboard shortcuts. More/Less preserves the chosen detail level. Light/dark themes and the existing accent/density settings still apply.

## Correctness changes

- Power Off remembers the site's previous positive filtering level. Power On restores it across popup closures and service-worker restarts.
- Turning a child site off preserves its parent's settings and siblings. Stock cosmetic and scriptlet registrations exclude the trusted child. A child override that the current mode representation cannot safely express is rejected with an actionable parent-rule message; it never silently rewrites the parent.
- Mode updates record a recovery journal before changing Chrome's DNR rules. They commit durable settings, restore metadata and session cache together, with rollback on failure. An interrupted update recovers the previous committed configuration on restart. A failed trusted-site read does not fall back to a default blocking configuration.
- Restricted browser/extension pages show unavailable controls. A strict-block interstitial can change its destination site's protection but cannot run picker/zapper scripts on the extension page. Reload checks that the original tab has not navigated elsewhere.
- Tool injection is awaited before closing the popup. Failed changes reconcile the displayed state with the background engine and show a localized error. Read initialization has a finite timeout/retry budget; manual retry does not replay a mutation.
- Permission handoffs have request identifiers and expire. Denied or unrelated grants do not reuse an earlier popup request. Permission changes share the filtering-operation queue and refresh stock and compiled script registrations.
- Smart popup status respects the current site's power and policy. Recent popup counts include only successful closures originating from the displayed hostname, not other sites or failed closure attempts.
- Dashboard shortcuts select the requested pane even if the dashboard is already open.

## What the controls mean

| Control | MV3 behavior |
| --- | --- |
| Power | Toggle filtering for the current site and its supported hostname scope. |
| Basic | Network filtering; stock extended cosmetics are disabled. |
| Optimal | Network filtering plus site-specific cosmetic filters and packaged scriptlets. |
| Complete | Adds generic cosmetic filtering. |
| Popup policy | Default, Allow, Smart or Strict policy for the current hostname; compiled filter-list rules retain their existing precedence. |
| My filters / Site rules | Open the corresponding editor; saving modes uses the same durable transaction path. |
| Reload | Refresh after a filtering change; Ctrl/Shift/Cmd bypasses the cache where supported. |

Filtering-mode settings and DNR persistence are transactional. Content-script and user-script registration remain separate browser operations after the mode commit; the popup rereads authoritative state if those operations fail, and retrying the same mode repairs registration. Reload is required to remove effects of scripts already injected into a page.

## MV3 boundaries retained

This does not emulate unsupported MV2 behavior. Unsupported popup conditions, missing context and exhausted matcher budgets continue to defer. Deferred allows remain conservative guards; stock popunder omission and complete-corpus suppression remain intact. DNR quotas, worker lifetime, browser restrictions and packaged-script requirements still apply. The popup does not invent full request counts or present limited DNR diagnostics as a complete network logger. See [the feature matrix](FEATURE-MATRIX.md) for engine-level limitations.

Popup closures use the background observer's opener and target checks. The legacy target-only synchronous closer is inert, including when invoked by a registration left over from an update, so it cannot bypass a trusted opener or incomplete-context deferral. This can allow a target to begin loading while the observer gathers context.

## Regression coverage

The release pipeline includes popup behavior, site-count/permission handoff, dashboard navigation, mode transaction/restart and script-scope tests in addition to the existing compiler, popup matcher, fail-open and DNR durability suites. Browser smoke checks run the real unpacked MV3 extension in a temporary Chromium profile, including actual network blocking across power Off/On, filtering level restoration and dashboard navigation. Results for this workspace build are stored under `tmp/popup-parity/`.

The subsequent [full regression review](MV3-RETEST-2026-09-05.md) expands this coverage to offscreen imports, custom-filter tools, backup/reset, keyboard focus, IP sites, old-browser conditions and upstream issue reproductions. Its release/browser evidence is under `tmp/full-retest/`.
