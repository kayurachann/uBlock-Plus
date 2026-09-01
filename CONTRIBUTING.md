# Contributing

Thank you for helping improve uBlock Plus+.

## Before opening an issue

- Fork-specific code, build, UI and documentation problems belong in this repository.
- A broken site caused by filter-list content should be reported to the maintainer of the matching list. uBlock-maintained list issues belong in the [uAssets tracker](https://github.com/uBlockOrigin/uAssets/issues).
- Issues that reproduce in official uBlock Origin/uBO Lite without this fork's changes should be reported upstream after confirming the problem there.

Include the fork version/commit, Chrome version, enabled rulesets, filtering mode, exact reproduction steps and sanitized troubleshooting output. Never post private browsing data, credentials or tokens.

## Pull requests

1. Create a focused branch from `main`.
2. Preserve GPL and third-party attribution.
3. Keep executable code packaged with the extension; remote code, `eval`, and downloaded script execution are not accepted.
4. Add or update tests and documentation for behavior changes.
5. Run the MV3 build, validator and lint checks before requesting review.

Prefer small patches that remain easy to rebase onto [`gorhill/uBlock`](https://github.com/gorhill/uBlock). Do not reformat unrelated upstream files.

## Translations

Translations inherited from upstream are maintained through [Crowdin](https://crowdin.com/project/ublock). Fork-specific UI strings use English as the required source and currently maintain complete Power coverage for German, Spanish, French, Japanese, Korean, Russian, Vietnamese, Simplified Chinese and Traditional Chinese.

The root `README.md` is the canonical English project README. Localized copies use `docs/README.<locale>.md`. When changing installation, security, privacy or MV3-limit wording, update every affected translation or open a clearly scoped translation follow-up; never remove a warning merely to shorten a translation. Preserve the 10-language selector and all relative image/document links.

Run `node tools/test-power-locales.mjs` and `node tools/test-readme-locales.mjs` before submitting translation changes. Machine-assisted translations are welcome as a draft, but a fluent reviewer should verify technical meaning, product names and safety language.
