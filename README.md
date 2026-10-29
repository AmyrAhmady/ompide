# Pawn IDE

A standalone Tauri 2 / React / TypeScript desktop IDE for open.mp and SA-MP Pawn.
PawnKit provides language intelligence and compiler orchestration. Development is
in progress; the application is not yet ready for an installed release.

Verified on Windows x64: a compact editor with top tabs, folder explorer, reusable
Monaco models, real Pawn completion/diagnostics/hover/signature help, definition
and reference navigation, cross-file rename, document/workspace symbols, folding,
formatting and supported code actions. Server recovery preserves unsaved buffers;
unsaved include changes update dependent analysis. Editing/save/save-all/undo,
unsaved Cancel/Discard prompts, reopen, recent-file history, external-file change
reconciliation, safe window closing, and Light/Dark switching with persisted
settings are also verified. English UI resources are in
`src/locales/en.json`; application colors and syntax themes are JSON data under
`src/settings/themes/`.

The Build menu selects a project and named build, verifies the bundled open.mp
compiler or an explicitly chosen compatible executable, saves open files and
compiles through PawnKit. Build output includes compiler logs, clickable
diagnostics, cancellation, exit status and the verified AMX location. Workspace
file/content search and previewed replacements include unsaved buffers and retain
Undo support. Explorer file management, custom-theme loading,
and installed packaging remain unfinished. Debugging is outside the project scope.

Deferred additions after the core IDE is stable: an integrated terminal, an
opt-in local MCP server for external AI agents, and an integrated title bar
replacing native window decorations. These are roadmap items, not current features.

## Development

Windows x64 prerequisites: Node.js 22.14 or newer in the supported Node 22 line,
npm (included with Node.js), Rust's MSVC toolchain (verified with Rust 1.91.1), Visual Studio C++
Build Tools with the Windows SDK, WebView2 Runtime, Git, and Windows `tar`.
Linux/macOS are intended future targets and have not been verified.

```powershell
npm ci
```

Use npm for all project commands; commit `package-lock.json` with dependency
changes. The project `.npmrc` disables automatic peer installation to avoid
[npm 10’s optional-peer resolver crash](https://github.com/npm/cli/issues/9787).
Windows PowerShell examples that forward flags use `npm.cmd` so the installed
`npm.ps1` shim preserves the argument separator. Editor dependencies are explicit and kept aligned by `package.json` overrides.

Prepare the pinned PawnKit tools and open.mp compiler explicitly before starting
the native application. This verifies the pinned GitHub release assets and the
patched language-server source build, then prepares ignored sidecars. Rebuilding
the server requires Go 1.26.5; see the toolchain notes for explicit setup and
checksum-pinned manual/offline paths. See [the toolchain notes](toolchain/README.md) for sources, licenses,
offline/manual preparation and compatibility workarounds.

```powershell
npm.cmd run tools:prepare -- --download
npm run tauri -- dev
```

`npm run dev` serves the frontend for development, but filesystem and language
operations require the native application. Merely opening a folder does not
install dependencies or download tools. Native file access is limited to the
selected workspace and files explicitly selected in native dialogs. UTF-8 files,
optional UTF-8 BOMs and existing LF/CRLF endings are supported; other encodings
and files over 8 MiB are rejected with guidance.

## Building a Pawn project

Open a folder, then choose **Build → Configure Project…**. Review the manifest,
entry point, target profile, declared include folders and output path. Workspaces
containing several projects require an explicit selection. Named builds can
select a different entry point; the displayed entry follows that selection.

Folders without a manifest offer entry-point and include-folder selection, a
PawnKit-generated preview, and an explicit **Create pawn.json** action. Previewing
does not write files. Existing manifests can be opened with **Edit Manifest**;
save changes and use **Refresh Configuration** before building.

Press **Ctrl+Shift+B** or use **Build Project**. Builds save open files first;
cancelling a Save As dialog prevents compilation. The bundled compiler is
[openmultiplayer/compiler 3.10.11](https://github.com/openmultiplayer/compiler/releases/tag/v3.10.11).
The artifact is `output/<entry-name>.amx` under the selected project. Compiler
output is returned at completion by PawnKit; the running state is indeterminate
and **Cancel Build** terminates the CLI and compiler. Editing remains available.

No project scripts, servers or automatic downloads run when opening or building
a project. Choose compatible external executables in Configure Project when
using manual/offline installations. The current Windows compiler workflow requires
ASCII project/compiler paths. For the pinned PawnKit YAML extension limitation,
see [the toolchain notes](toolchain/README.md).

## Workspace search

Use **Ctrl+P** to find workspace files by path and **Ctrl+Shift+F** for literal
content search. The search panel respects ignore files and offers a path filter,
case matching and explicit refresh. **Preview Replace All…** shows a diff before
applying changes to owned editor buffers; **Save All** writes them to disk.
Changed buffers or files invalidate old previews. Search excludes dependency/build
directories, symlinks, binary/unsupported files and files over 8 MiB; results and
preview sizes are bounded, with incomplete previews prevented from applying.

## Verification

Use `npm run format` to format all supported files under `src` with the project
Prettier configuration and ESLint blank-line rules. Keep functions and class
members visually separated and write readable blocks rather than dense chains
of statements. `npm run format:check` checks formatting and spacing without
changing files.

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all --check
cargo test --manifest-path src-tauri/Cargo.toml -p pawn-core
cargo clippy --manifest-path src-tauri/Cargo.toml --workspace --all-targets -- -D warnings
npm run test:tools
```

The offline frontend/core tests do not require PawnKit tools. `test:tools` is an
explicit real-server/compiler test; it builds only the small Rust bridge harness,
requires the prepared binaries, and fails if they are missing. Run focused checks
for routine changes; a full native build is needed only when native integration
or packaging needs verification.

Run `node scripts/menu-smoke.mjs` for the menu interaction regression. It uses
the installed Windows Edge browser in headless mode and a test-owned Vite server
on an ephemeral loopback port. It checks switching, dismissal, keyboard navigation,
and both themes at a scaled viewport; it does not exercise native services.

For the real desktop smoke test, start `npm run dev`, then launch the debug executable
from a separate PowerShell process with a temporary loopback CDP port:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1'
& .\src-tauri\target\debug\omp-pawn-editor.exe
```

In another terminal run `node scripts/native-smoke.mjs`. The script uses real
Tauri IPC and real PawnKit, backs up/restores preferences, operates on disposable
fixture copies, and records screenshots under the ignored `test-results/`.
Add `--close` to verify cancelling a multi-document exit preserves all tabs and
edits, then discarding closes the real application. The script also verifies
external clean reloads, conflicting dirty edits, and entry-file rename/restore.
Do not enable the inspection port for ordinary use or distributed builds.

Run `node scripts/build-smoke.mjs` with the same native inspection setup for
compilation, diagnostic navigation, manifest setup, named builds, YAML, official
open.mp includes, cancellation and compatible external tool selection. Prepare
the [open.mp fixture](fixtures/openmp/README.md) first. This test uses disposable
projects, restores preferences and closes the test application.

`node scripts/search-smoke.mjs` checks real native search, Unicode navigation,
unsaved overlays, replacement diff/cancel/apply/Undo/Save All, unopened files,
BOM/CRLF preservation, stale preview rejection and keyboard file lookup. It also
uses disposable files, restores preferences and closes the test application.

Run `node scripts/language-smoke.mjs` against a freshly launched debug application
with the same inspection setup for the advanced language workflows. It verifies
real hover/signature/reference UI, rename into unopened files, symbols, formatting,
code actions, crash recovery, executable selection, and unsaved include macros
against the pinned [open.mp fixture](fixtures/openmp/README.md). Prepare that
fixture explicitly before running. The script restores preferences, uses disposable
project copies, closes the test application, and records evidence in `test-results/`.

Native Windows Open File, Save As and Open Folder were additionally exercised
through their actual OS dialogs using disposable fixtures. Save As preserved
the exact source text; folder selection populated the explorer and recent history.

To check production frontend assets embedded in a native executable, build with
`npm.cmd run tauri -- build --debug --no-bundle`, launch the resulting debug executable with
the temporary CDP environment above, and run `node scripts/production-smoke.mjs`.
This UI-only test requires `tauri.localhost`, verifies copied sidecar hashes, and
checks real completion/navigation, Unicode edits/save, argument-count diagnostics,
themes and Exit without Vite or development-module access. The Rust executable
uses the debug profile; a release-optimized installer remains unverified.

## Shortcuts

| Action | Shortcut |
| --- | --- |
| New / Open File | Ctrl+N / Ctrl+O |
| Open Folder | Ctrl+K, Ctrl+O |
| Save / Save As / Save All | Ctrl+S / Ctrl+Shift+S / Ctrl+Alt+S |
| Close / Reopen Editor | Ctrl+W / Ctrl+Shift+T |
| Find / Replace | Ctrl+F / Ctrl+H |
| Go to Definition / References / Rename | F12 / Shift+F12 / F2 |
| Symbols in Editor / Workspace | Ctrl+Shift+O / Ctrl+T |
| Format Document | Shift+Alt+F |
| Build Project | Ctrl+Shift+B |
| Find File / Search Workspace | Ctrl+P / Ctrl+Shift+F |
| Problems / Settings | Ctrl+J / Ctrl+, |

Source/tool provenance and upstream integration limitations are documented in
[toolchain/README.md](toolchain/README.md). The detailed local implementation plan,
project agent instructions and design references are intentionally Git-ignored.
