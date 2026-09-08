# Building uBlock Plus+

This directory contains the uBlock Plus+ MV3 extension, ruleset compiler and platform manifests, including inherited upstream MV3 components.

## Windows

Requirements: Chrome/Chromium or Edge 130+, PowerShell 5.1 or newer, Node.js 22 or newer, Git submodules and network access.

```powershell
.\tools\make-mv3.ps1 -Platform chromium
```

Add `-Full` to create a zip or `-Version 1.1.0` to create a release-style package with that Chromium manifest version. The PowerShell build requires no GNU Make, Bash, `jq` or external `zip` executable.

## Linux/macOS

```bash
git submodule update --init --recursive
make mv3-chromium
```

Upstream also supports `mv3-edge`, `mv3-firefox` and `mv3-safari`; this community fork's CI currently guarantees the Chromium target.

## Outputs

- Unpacked extension: `dist/build/uBlockPlus.chromium`
- Full package: `dist/build/uBlock-Plus_<version>.chromium.zip`
- Conversion report: `dist/build/uBlockPlus.chromium/log.txt`
- Downloaded list cache: `dist/build/mv3-data`

Validate an assembled extension with:

```bash
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium
```

## Optional Experimental WebRequest package (Windows)

```powershell
.\tools\make-mv3.ps1 -Platform chromium -Version 1.1.0 -ExperimentalWebRequest
node tools/validate-mv3.mjs dist/build/uBlockPlus.experimental.chromium --release --experimental-webrequest
```

The separate `uBlockPlus.experimental.chromium` output and `uBlock-Plus_1.1.0.experimental.chromium.zip` include a dedicated-profile Chrome launcher. They supplement DNR with synchronous firewall blocking when the browser grants `webRequestBlocking`; they do not replace the complete static engine or remove quotas. See the [setup and fallback guide](https://github.com/kayurachann/uBlock-Plus/blob/main/docs/EXPERIMENTAL-WEBREQUEST.md). The standard build never requests the blocking permission.

The build compiles supported uBO/ABP network filters into DNR rules and prepares declarative cosmetic/scriptlet resources. Filter lists are live external inputs, the cache contains a generated secret, and development versions can be date-generated; independent builds are therefore not expected to be byte-for-byte identical.

This is an independent fork. See the project [README](https://github.com/kayurachann/uBlock-Plus#readme), [compatibility matrix](https://github.com/kayurachann/uBlock-Plus/blob/main/docs/FEATURE-MATRIX.md) and [attribution notice](https://github.com/kayurachann/uBlock-Plus/blob/main/NOTICE.md).
