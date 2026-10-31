# Windows builds

The [Windows build workflow](https://github.com/AmyrAhmady/ompide/actions/workflows/windows-build.yml)
creates an unsigned Windows x64 ZIP and a SHA-256 checksum file. It runs for code
changes on `master`, pull requests, `v*` tags, and manual runs. Documentation-only
branch changes are skipped. Artifacts are kept for 14 days; this workflow does
not create a GitHub Release or publish installers.

Open a successful run and download `ompide-<version>-windows-x64.zip` from
**Artifacts**. Extract the whole ZIP and run `ompide.exe`. The uploaded file is
the actual application ZIP, without an extra archive around it.

## Included files

| File or directory                              | Purpose                                                                             |
| ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ompide.exe`                                   | Release application with its editor assets embedded.                                |
| `pawnlsp.exe`                                  | The pinned language server.                                                         |
| `binaries/compiler/pawnc-3.10.11-windows/bin/` | Compiler, pinned `pawnc.dll`, and its Microsoft-signed x86 `vcruntime140.dll`.      |
| `licenses/`, `binaries/licenses/`, `LICENSE`   | Project, grammar, dependency and bundled-tool notices, with dependency inventories. |
| `README.txt`                                   | Instructions for running the ZIP build.                                             |
| `release-manifest.json`                        | Version, source commit, tool versions, runtime provenance and file hashes.          |

Windows 10/11 x64 and Microsoft Edge WebView2 Runtime are prerequisites. Install
Git separately to use Source Control. Node.js, Rust, Go and a development checkout
are not needed to run the ZIP. Project includes and libraries remain your
project's responsibility. Settings still live in the Windows app-data directory;
this is an extract-and-run package, not a separate portable-settings mode.

## Build locally

Follow the [source build guide](https://github.com/AmyrAhmady/ompide/wiki/Building-from-Source)
to install prerequisites and prepare the pinned tools. Packaging also needs the
x86 Visual C++ v14 redistributable files supplied with Visual Studio 2022 or 2026
C++ Build Tools; the packaging script locates them with `vswhere` and verifies
Microsoft's signature before copying the required runtime.

CI checks for the compiler runtime before compiling Rust. Discovery supports
the v143 and v145 CRT layouts and both numeric and alias version directories;
it selects the newest installed x86 runtime and requires a valid Microsoft
signature.

```powershell
npm ci
npm.cmd run tools:prepare -- --download
npm run release:build
npm run release:package
npm run release:verify
```

Tool preparation is explicit and checksum-verified. When rebuilding pawnlsp, set
`OMPIDE_GO` to Go 1.26.5 as described in the source build guide. The checked-in
`rust-toolchain.toml` selects the tested Rust toolchain automatically.

`release:build` runs the production frontend build through Tauri and compiles the
optimized native executable with the Cargo lockfile enforced. Packaging writes
the ZIP and `.zip.sha256` under the ignored `release/` directory. Verification
extracts that ZIP into a fresh folder, checks file hashes and DLL dependencies,
then tests the delivered language server and compiler through the Rust bridge.
It does not replace manual desktop or clean-machine installation testing.

For a local desktop check, close other ompide windows and run
`npm run release:smoke`. It starts the extracted release outside the checkout,
checks real editing/language/build operations, then closes the test app and
restores your settings. This interactive check is separate from headless CI.

To inspect a debug build, `release:package` and `release:verify` accept
`-- --debug`. These files have a `-debug.zip` suffix and are not the release
artifact uploaded by CI. A debug executable must also be built with Tauri's
production frontend; a development executable expecting Vite is unsuitable.

Verify a downloaded ZIP against its accompanying checksum in PowerShell:

```powershell
Get-FileHash .\ompide-0.1.0-windows-x64.zip -Algorithm SHA256
Get-Content .\ompide-0.1.0-windows-x64.zip.sha256
```

## Versions and release tags

Keep `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` versions
in agreement. The workflow rejects a tag that differs from `v<version>`, so
`v0.1.0` must build version `0.1.0`. Only tag a commit after its build has passed.
The GitHub artifact's source commit is recorded inside the package; local builds
also record whether the checkout had uncommitted changes.

Tool hashes and companion DLLs are pinned in `toolchain/tools.json`. The Go
version/source/patch are pinned in `toolchain/pawnlsp-build.json`. Workflow actions
use full commit IDs, npm uses `package-lock.json`, and Rust uses `Cargo.lock`.
Do not add unreviewed executables or copy an entire development output directory
into the ZIP. The packaging script copies only the required app/tool files and
license directories and rejects unresolved non-system DLL imports.

Dependency notices are collected from the installed npm packages, locked Cargo
sources and the modules actually compiled into pawnlsp. Where a published package
omits its license files, `packaging/licenses/` holds copies from the matching
upstream source, with URLs and checksums in `sources.json`. Packaging stays offline
and fails if a dependency has no license text; review these copies when updating
dependencies.
