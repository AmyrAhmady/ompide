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
Undo support. Explorer creation, rename, recoverable deletion, current-file reveal
and keyboard/context-menu workflows are also verified on Windows. Installed
packaging remains unfinished. Debugging is outside the project scope.

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

## Commands

Press **F1** or **Ctrl+Shift+P**, or use **View → Command Palette…**, to search
commands by words or shortcut. Arrow keys select an available command, Enter runs
it and Escape restores focus. Unavailable commands are identified explicitly.
**Ctrl+P** remains workspace file lookup.

Menus and the palette use the same command definitions and availability rules.
Pawn language actions require a real Pawn file and negotiated server support;
they are unavailable for untitled or JSON buffers. Reopen becomes available after
closing a file. The palette also offers Focus Editor, Toggle Minimap and Toggle
Word Wrap; editor preferences persist in the application data directory.

## Layout

Drag the divider beside the sidebar or above the bottom panel to resize it.
Preferences save when the drag ends. Focus a divider to resize with arrow keys
(10 pixels, or 50 with Shift); Home/End select its limits, double-click restores
its default size and Escape cancels a drag. Small windows temporarily constrain
pane sizes while retaining the preferred dimensions for a larger window.

**Ctrl+B** toggles the sidebar without losing expanded Explorer folders or the
current Search input. Search/Explorer commands also reveal and focus the chosen
view. **Toggle Bottom Panel** reopens the last selected Problems or Build view;
only one bottom view appears at a time. Pane sizes, visibility and selected views
survive restart. **View → Reset Layout** restores the initial layout.

## Themes

Open **Settings** with **Ctrl+,** to select Light, Dark or your saved custom theme.
**Customize Theme…** opens an editable JSON copy of the current theme.
**Load Theme File…** reads an explicitly selected local JSON file into that editor.
Review it and choose **Apply Custom Theme** to update the application and Monaco;
**Cancel Theme Changes** keeps the previous theme. Invalid data leaves the active
theme intact and reports the field to fix.

The application stores one custom theme snapshot in its preferences, alongside
the selected theme. Applying another replaces that snapshot. Imported files are
never modified or watched, and startup does not depend on their original path.
Keep separate JSON files for variants: copy the editor text into a `.json` file
and load it again after making external edits. No theme code or network resources
are executed. The format is specific to Pawn IDE; it is not a VS Code theme importer.

Start with [Ocean](examples/themes/ocean.json), or this minimal theme:

```json
{
  "schemaVersion": 1,
  "name": "My Theme",
  "base": "dark",
  "colors": { "editor.background": "#10232a" },
  "tokenColors": [
    { "scope": "constant.numeric", "settings": { "foreground": "#ff9e65" } }
  ]
}
```

Version 1 requires a name of 1–64 characters and `base` of `light` or `dark`.
`colors` and `tokenColors` are optional. Missing colors and syntax rules inherit
the chosen built-in base. Syntax rules override matching TextMate scopes;
each needs a nonempty `scope` of at most 256 characters and an opaque
`settings.foreground` color. Up to 500 rules and 256 KiB per file are accepted.
JSON comments are unsupported; UTF-8 BOM is accepted. Unknown top-level fields
are ignored. Unknown color tokens, malformed rules and unsupported versions
are rejected. Colors use `#RRGGBB` or `#RRGGBBAA`; syntax foregrounds use `#RRGGBB`.

These versioned color tokens are shared with the shell and Monaco where relevant:

| Area | Tokens |
| --- | --- |
| Editor | `editor.background`, `editor.foreground`, `editor.selectionBackground`, `editor.lineHighlightBackground`, `editorLineNumber.foreground`, `editorCursor.foreground` |
| Widgets and diagnostics | `editorWidget.background`, `editorWidget.border`, `editorSuggestWidget.selectedBackground`, `editorError.foreground`, `editorWarning.foreground` |
| Sidebar and header | `sideBar.background`, `sideBar.foreground`, `activityBar.background`, `titleBar.activeBackground` |
| Tabs and panels | `tab.activeBackground`, `tab.inactiveBackground`, `panel.background`, `panel.border` |
| Status | `statusBar.background`, `statusBar.foreground` |
| Interaction | `focusBorder`, `list.hoverBackground`, `list.activeSelectionBackground`, `button.background`, `button.foreground` |
| Inputs and secondary text | `input.background`, `input.foreground`, `input.border`, `descriptionForeground` |

Use the complete [Dark](src/settings/themes/dark.json) and
[Light](src/settings/themes/light.json) files to inspect every default value.

## Explorer

Use the Explorer toolbar or a folder's context menu to create files and folders.
New files open for editing. **Ctrl+Shift+E** switches from Search to Explorer,
expands the active file's parents and focuses its row; the reveal toolbar button
does the same for a file in the current workspace.

Use arrow keys, Home/End and name-prefix typing to navigate. Enter opens a file
or toggles a folder. **Insert** creates a file, **Shift+Insert** creates a folder,
**F2** renames, **Delete** opens a deletion confirmation, and **Shift+F10** opens
the context menu. Escape dismisses the menu and restores row focus.

Renaming or recycling a folder confirms all affected dirty editors before moving
anything. Cancelling a later prompt preserves earlier Discard choices as unsaved
buffers. After confirmation, renamed files reopen at their new paths; existing
destination files and open destination tabs cannot be overwritten. Edits that
arrive during a filesystem operation retain their original buffer with Save As
guidance. Build selection is invalidated when its manifest or entry is moved.

Deletion uses the Windows Recycle Bin on local fixed drives, with explicit
confirmation. Network and removable locations are refused rather than offering
permanent deletion. Restore recycled files using the operating system.

## Verification

`npm run audit:localization` checks literal JSX copy/accessibility labels,
translation keys, frontend/native error-code coverage and English resource
shapes. Product names, keyboard labels, UTF-8 and the case-match icon remain
stable identifiers. Strict TypeScript additionally checks translation-key unions;
unit tests exercise a French test resource with English fallback, plurals and
named interpolation. Only English ships. Internal protocol errors and raw
compiler/LSP messages remain technical output; native errors expose structured
codes/parameters instead of displaying their diagnostic detail as UI copy.

Add future translations as resources for `createTranslator` in `src/lib/i18n.ts`.
Use the keys and interpolation names from `src/locales/en.json`; the helper
accepts a locale and partial resources, falling back to English for omitted keys.
Runtime language selection/resource packaging is left for those later languages.

Use `npm run format` to format all supported files under `src` with the project
Prettier configuration and ESLint blank-line rules. Keep functions and class
members visually separated and write readable blocks rather than dense chains
of statements. `npm run format:check` checks formatting and spacing without
changing files.

```powershell
npm run format:check
npm run lint
npm run audit:localization
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

Run `node scripts/explorer-smoke.mjs` with the same native inspection setup for
creation, collision/traversal rejection, multi-tab folder rename/cancellation,
case-only rename, keyboard/context-menu/reveal behavior and recoverable deletion.
It uses a disposable workspace, restores preferences, restores only its exact
Recycle Bin fixtures, records Light/Dark screenshots and closes the application.
The core `restore_explorer_smoke_items` test is excluded from ordinary unit runs
because it requires that live smoke fixture; the script explicitly supplies the
fixture path and runs the helper with `--ignored` to verify restoration.

Run `node scripts/commands-smoke.mjs` with the same inspection setup to verify
palette shortcuts/search, unavailable commands, real Save All, Settings/Find,
persisted Monaco toggles, reopen history and dialog focus restoration. The script
backs up/restores preferences, uses disposable source files, records Light/Dark
screenshots and closes the test application.

Run `node scripts/layout-smoke.mjs` with the same inspection setup for pointer
and keyboard resizing, cancellation, focus, native preference restoration and a
scaled viewport with an external-file conflict. It records both themes, restores
preferences and closes the application.

Run `node scripts/theme-smoke.mjs` to verify local file import, validation,
customization/cancellation, Monaco syntax colors, Light/Dark/custom switching
and native preference reload. It also rejects CSS/network content, records
custom-theme screenshots and restores preferences before closing the test app.

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
| Toggle Sidebar / Reveal Explorer | Ctrl+B / Ctrl+Shift+E |
| Command Palette | F1 / Ctrl+Shift+P |

Source/tool provenance and upstream integration limitations are documented in
[toolchain/README.md](toolchain/README.md). The detailed local implementation plan,
project agent instructions and design references are intentionally Git-ignored.
