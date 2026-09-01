# Building uBlock Plus+

This directory contains the MV3-specific extension, ruleset compiler and platform manifests inherited from the upstream uBO Lite implementation.

## Windows

Requirements: Chrome/Chromium or Edge 130+, PowerShell 5.1 or newer, Node.js 22 or newer, Git submodules and network access.

```powershell
.\tools\make-mv3.ps1 -Platform chromium
```

Add `-Full` to create a zip or `-Version 1.0.0` to create a release-style package with that Chromium manifest version. The PowerShell build requires no GNU Make, Bash, `jq` or external `zip` executable.

## Linux/macOS

```bash
git submodule update --init --recursive
make mv3-chromium
```

Upstream also supports `mv3-edge`, `mv3-firefox` and `mv3-safari`; this community fork's CI currently guarantees the Chromium target.

## Outputs

- Unpacked extension: `dist/build/uBOLite.chromium`
- Full package: `dist/build/uBlock-Plus_<version>.chromium.zip`
- Conversion report: `dist/build/uBOLite.chromium/log.txt`
- Downloaded list cache: `dist/build/mv3-data`

Validate an assembled extension with:

```bash
node tools/validate-mv3.mjs dist/build/uBOLite.chromium
```

The build compiles supported uBO/ABP network filters into DNR rules and prepares declarative cosmetic/scriptlet resources. Filter lists are live external inputs, the cache contains a generated secret, and development versions can be date-generated; independent builds are therefore not expected to be byte-for-byte identical.

This is an independent fork. See the project [README](https://github.com/kayurachann/uBlock-Plus#readme), [compatibility matrix](https://github.com/kayurachann/uBlock-Plus/blob/main/docs/FEATURE-MATRIX.md) and packaged [attribution notice](NOTICE.md).
