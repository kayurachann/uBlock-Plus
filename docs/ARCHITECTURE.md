# MV3 architecture

## Build-time path

1. Upstream uBO/ABP filter lists are downloaded into a local cache.
2. The upstream parser converts supported network filters into sharded static DNR rulesets.
3. Cosmetic selectors and references to packaged scriptlets are compiled into extension resources.
4. Conversion statistics and rejected/unsupported filters are written to the build log.

The assembled extension contains only packaged executable code. Remote filter lists are data, never JavaScript modules.

## Runtime path

- Chrome's DNR engine evaluates network rules without waking the extension service worker for every request.
- The service worker manages settings, per-site modes, ruleset selection, migrations and idempotent dynamic/session rule updates.
- Static and dynamically registered `document_start` scripts handle cosmetic filtering and packaged scriptlets.
- An offscreen document is created only for parsing/compilation work that cannot run in the service worker; it is not used as a permanent MV2-style background page.
- User/imported lists compile network filters into dynamic DNR rules. Supported cosmetic/scriptlet data is registered through packaged code and the `userScripts` API where available.
- Important state lives in extension storage because Chrome may terminate the service worker after it becomes idle.

## Rule safety

Static, dynamic, session and special mode rules use separate ID ranges and explicit priorities. Updates remove and add the intended IDs atomically where the API permits. On extension updates, enabled static rulesets and session rules are reconstructed from persisted configuration because Chrome does not preserve all static/session state across an extension update.

## Upstream synchronization

The repository keeps the official project as the `upstream` remote. Community-specific changes are intentionally concentrated in MV3 manifests/UI, documentation, validation, CI and portable build tooling so upstream security and parser changes can be merged with a reviewable conflict surface.
