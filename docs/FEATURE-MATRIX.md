# MV2-to-MV3 compatibility matrix

Chrome MV3 public extensions cannot use `webRequestBlocking`; they must express blocking and modification as Declarative Net Request rules. This is an API-level constraint, not a missing manifest flag.

| Capability | uBlock Origin MV2 | This MV3 fork | Notes |
| --- | --- | --- | --- |
| Static network blocking | Runtime engine | Yes, static DNR rulesets | Filter syntax is compiled at build time. |
| User/imported network filters | Runtime engine | Yes, dynamic DNR | Subject to Chrome dynamic and regex quotas. |
| Per-site allow/filtering modes | Yes | Yes | Implemented with persisted configuration and DNR rules. |
| Cosmetic filtering | Yes | Yes | Declarative/dynamically registered content scripts and CSS. |
| Procedural cosmetic filters | Yes | Partial | Only forms representable safely in packaged scripts. |
| Packaged scriptlets | Yes | Yes | Remote executable code is never loaded. |
| Element picker/zapper | Yes | Yes | Custom cosmetic filters are persisted locally. |
| Strict blocking / popup blocking | Yes | Yes | Implemented through generated rules and content scripts. |
| Custom filter-list URLs | Yes | Yes | Lists are treated as data and compiled locally on demand. |
| Backup/restore | Yes | Yes | Covers extension filtering configuration. |
| Live full request logger | Yes | Limited | MV3 DNR feedback is restricted and development-only in places. |
| Response-body/HTML rewriting | Yes on supported engines | No | DNR cannot rewrite arbitrary response bodies. |
| CNAME uncloaking / DNS resolution | Yes on supported engines | No | Chrome MV3 exposes no equivalent DNS resolution path. |
| Response-size-based media blocking | Yes | No exact equivalent | DNR decides before the required response information is available. |
| Arbitrary synchronous dynamic firewall decisions | Yes | Partial | Rules must be declared ahead of the request. |
| All uBO regex/modifier syntax | Yes | Partial | DNR uses RE2-compatible regexes and has rule/regex quotas. |

Current Chrome DNR limits include up to 100 declared static rulesets, 50 enabled static rulesets, at least 30,000 guaranteed static rules, 30,000 safe dynamic rules, 5,000 unsafe dynamic rules, 5,000 session rules, and 1,000 regex rules per relevant ruleset group. Limits can change; see the official [Declarative Net Request API reference](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest).

The design deliberately follows the current upstream MV3 implementation. For an exhaustive list of unsupported filter syntax, consult the upstream [uBO Lite FAQ](https://github.com/uBlockOrigin/uBOL-home/wiki/Frequently-asked-questions-(FAQ)).
