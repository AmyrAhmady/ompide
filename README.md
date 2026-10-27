# Pawn IDE

A standalone Tauri 2 / React / TypeScript desktop IDE for open.mp and SA-MP Pawn.
PawnKit provides language intelligence and compiler orchestration. Development is
in progress; the application is not yet ready for an installed release.

Verified on Windows x64: a compact editor with top tabs, folder explorer, reusable
Monaco models, real Pawn completion and diagnostics, F12 navigation into includes,
editing/save/undo, unsaved Cancel/Discard prompts, reopen, and Light/Dark theme
switching with persisted settings. English UI resources are in
`src/locales/en.json`; application colors and syntax themes are JSON data under
`src/settings/themes/`.

The real compiler workflow is verified through an integration harness, but the
application's Build UI is not implemented yet. External-file watching, full file
management/search/replace, custom-theme loading, native file-dialog smoke tests,
and installed packaging remain unfinished. Debugging is outside the project scope.

## Development

Windows x64 prerequisites: Node.js 22.14 or newer in the supported Node 22 line,
pnpm 11.25.0, Rust's MSVC toolchain (verified with Rust 1.91.1), Visual Studio C++
Build Tools with the Windows SDK, WebView2 Runtime, Git, and Windows `tar`.
Linux/macOS are intended future targets and have not been verified.

```powershell
pnpm install --frozen-lockfile
```

Prepare the pinned PawnKit tools and open.mp compiler explicitly before starting
the native application. This downloads the GitHub release assets listed in
`toolchain/tools.json`, verifies their SHA-256 checksums and prepares ignored
sidecar files. See [the toolchain notes](toolchain/README.md) for sources, licenses,
offline/manual preparation and compatibility workarounds.

```powershell
pnpm tools:prepare --download
pnpm tauri dev
```

`pnpm dev` serves the frontend for development, but filesystem and language
operations require the native application. Merely opening a folder does not
install dependencies or download tools. Native file access is limited to the
selected workspace and files explicitly selected in native dialogs. UTF-8 files,
optional UTF-8 BOMs and existing LF/CRLF endings are supported; other encodings
and files over 8 MiB are rejected with guidance.

## Verification

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo test --manifest-path src-tauri/Cargo.toml -p pawn-core
cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings
pnpm test:tools
```

The offline frontend/core tests do not require PawnKit tools. `test:tools` is an
explicit real-server/compiler test; it builds only the small Rust bridge harness,
requires the prepared binaries, and fails if they are missing. Run focused checks
for routine changes; a full native build is needed only when native integration
or packaging needs verification.

For the real desktop smoke test, start `pnpm dev`, then launch the debug executable
from a separate PowerShell process with a temporary loopback CDP port:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1'
& .\src-tauri\target\debug\omp-pawn-editor.exe
```

In another terminal run `node scripts/native-smoke.mjs`. The script uses real
Tauri IPC and real PawnKit, backs up/restores preferences, operates on disposable
fixture copies, and records screenshots under the ignored `test-results/`.
Do not enable the inspection port for ordinary use or distributed builds.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| New / Open File | Ctrl+N / Ctrl+O |
| Open Folder | Ctrl+K, Ctrl+O |
| Save / Save As / Save All | Ctrl+S / Ctrl+Shift+S / Ctrl+Alt+S |
| Close / Reopen Editor | Ctrl+W / Ctrl+Shift+T |
| Find / Replace | Ctrl+F / Ctrl+H |
| Go to Definition / References / Rename | F12 / Shift+F12 / F2 |
| Format Document | Shift+Alt+F |
| Problems / Settings | Ctrl+J / Ctrl+, |

Source/tool provenance and upstream integration limitations are documented in
[toolchain/README.md](toolchain/README.md). The detailed local implementation plan,
project agent instructions and design references are intentionally Git-ignored.
