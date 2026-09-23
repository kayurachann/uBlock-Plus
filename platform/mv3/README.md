# Building uBlock Plus+

This directory contains the uBlock Plus+ MV3 extension, ruleset compiler and platform manifests, including inherited upstream MV3 components.

## Windows

Requirements: Chrome/Chromium or Edge 130+, PowerShell 5.1 or newer, Node.js 22 or newer, Git submodules and network access.

From the repository root:

```powershell
# The build copies files from the codemirror-ubol and s14e-serializer submodules.
git submodule update --init --recursive
# The default Windows policy blocks local scripts; allow them for this window only.
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
$version = (Get-Content -Raw package.json | ConvertFrom-Json).version
.\tools\make-mv3.ps1 -Platform chromium -Version $version
```

`-Version` sets the Chromium manifest version and creates `uBlock-Plus_<version>.chromium.zip` with its `.sha256`. Without it the build gets a date-generated development version (use `-Full` to still create a ZIP). Development builds (first version number 2000 or higher) never check for or install updates. The PowerShell build requires no GNU Make, Bash, `jq` or external `zip` executable.

## Linux/macOS

```bash
git submodule update --init --recursive
make mv3-chromium
```

Upstream also supports `mv3-edge`, `mv3-firefox` and `mv3-safari`; this community fork's CI currently guarantees the Chromium target.

## Outputs

- Unpacked extension: `dist/build/uBlockPlus.chromium`
- Full package: `dist/build/uBlock-Plus_<version>.chromium.zip` and `.sha256`
- Optional Windows updater inside the package: `updater/` (see [automatic updates](https://github.com/kayurachann/uBlock-Plus/blob/main/docs/AUTO-UPDATE.md)), with `updater/package-files.json`, the list of package files that the updater may replace or delete. The validator checks that this list matches the build.
- Conversion report: `dist/build/uBlockPlus.chromium/log.txt`
- Downloaded list cache: `dist/build/mv3-data`

Validate an assembled extension with:

```bash
node tools/validate-mv3.mjs dist/build/uBlockPlus.chromium
```

## Releases

Releases are built and published only by the [Release workflow](https://github.com/kayurachann/uBlock-Plus/blob/main/.github/workflows/release.yml). Pushing a `v<version>` tag that matches `package.json` starts it, and a tag push publishes a pre-release. A read-only build job (`npm ci --ignore-scripts`, tests, lint, build, validation) builds both packages. A separate publish job signs them when a release signing key is published, attests build provenance and uploads them under the names that the updater expects. Do not upload ZIPs by hand: a rerun fails when an asset already on the release differs from its own build. Releases before 1.2.0 were uploaded by hand and have no attestation.

The workflow can also be run by hand (**Actions → Release → Run workflow**) for an existing tag, with the option **Mark the GitHub release as a pre-release**. It sets the pre-release flag only when it creates the release, and it never changes the flag of an existing release. A release first published by a tag push therefore stays a pre-release, and **Stable releases only** and `-StableOnly` do not offer it, until you clear the flag on GitHub: **Edit release**, or `gh release edit v<version> --prerelease=false`. A manual run for a tag that already has a release rebuilds the ZIPs, which are not byte-identical to the uploaded ones, so it fails. To finish a partly published release, use **Re-run failed jobs** within the 7 days the build artifact is kept. See [automatic updates](https://github.com/kayurachann/uBlock-Plus/blob/main/docs/AUTO-UPDATE.md) for the release workflow and the signing keys.

## Optional Experimental WebRequest package (Windows)

In the same PowerShell window as the [Windows](#windows) commands above, which set the execution policy and `$version`:

```powershell
.\tools\make-mv3.ps1 -Platform chromium -Version $version -ExperimentalWebRequest
node tools/validate-mv3.mjs dist/build/uBlockPlus.experimental.chromium --release --experimental-webrequest
```

The separate `uBlockPlus.experimental.chromium` output and `uBlock-Plus_<version>.experimental.chromium.zip` include a dedicated-profile Chrome launcher. They supplement DNR with synchronous firewall blocking when the browser grants `webRequestBlocking`; they do not replace the complete static engine or remove quotas. See the [setup and fallback guide](https://github.com/kayurachann/uBlock-Plus/blob/main/docs/EXPERIMENTAL-WEBREQUEST.md). The standard build never requests the blocking permission.

The build compiles supported uBO/ABP network filters into DNR rules and prepares declarative cosmetic/scriptlet resources. Filter lists are live external inputs, the cache contains a generated secret, and development versions can be date-generated; independent builds are therefore not expected to be byte-for-byte identical.

This is an independent fork. See the project [README](https://github.com/kayurachann/uBlock-Plus#readme), [compatibility matrix](https://github.com/kayurachann/uBlock-Plus/blob/main/docs/FEATURE-MATRIX.md) and [attribution notice](https://github.com/kayurachann/uBlock-Plus/blob/main/NOTICE.md).
