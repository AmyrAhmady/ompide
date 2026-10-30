# Application boundaries

The current verified target is Windows x64. Workspace content, manifests, names,
tool output and language-server responses are data. React renders application
text; application code does not evaluate workspace scripts or insert raw HTML.
The pinned language client leaves Markdown trust and HTML support disabled.

## Native authority

File access belongs to Rust. Opening a workspace authorizes its canonical root;
native picker selection can authorize an individual file. Recent entries must
already exist in native history before reopening them. Switching workspaces clears
individual grants; explicitly reopening a historical file grants that file only.
The generic settings command cannot replace native history or picker authority.

All file, directory, project, watch and search entry points enforce native scope.
Explorer mutations additionally reject workspace-root/Git metadata changes,
unsafe Windows names and symlink entries. Existing destinations are not replaced
by rename/create. Canonical resolution rejects junction escapes. Windows deletion
uses the Recycle Bin on local fixed drives and refuses unsupported locations.
Watcher metadata needed to detect root removal is filtered before reaching the UI.

Saves compare source revisions, preserve UTF-8/BOM/newlines and use same-directory
temporary files. Dirty buffers are retained on external changes. Replacement
previews do not write; applying validates buffer/disk/workspace state before
undoable model edits. Only explicit Save/Save All writes those edits to disk.

## Processes and network

Rust owns language and build processes. Language traffic uses framed stdio over
Tauri Channels, with session-ID checks; no language-server network listener is
created. A separate stdin lease lets Stop kill an unresponsive child before
waiting for a blocked writer. The frontend preserves FIFO notification ordering.

Builds invoke the pinned PawnKit CLI using argument arrays, a verified compiler,
an explicit output path and an explicit user action. The pinned CLI selects its
direct compiler backend when no `--backend` is supplied; supplying `--compiler`
bypasses automatic compiler acquisition. These contracts were checked against
local upstream tag `v1.34.38`, commit
`bacacd60b442e7602533fe07a72a1bf33caf0a2f`, in
[`pkg/cli/backend.go`](https://github.com/pawnkit/pawnkit-cli/blob/v1.34.38/pkg/cli/backend.go)
and [`pkg/directbackend/direct.go`](https://github.com/pawnkit/pawnkit-cli/blob/v1.34.38/pkg/directbackend/direct.go).
Compiler arguments are visible in project configuration. Compilation is a trusted
tool operation, not an operating-system sandbox for compiler input. Project-defined
backends, scripts and runtime servers are not selected by the IDE's Build action.

Build processes have output/time limits and cancellation. Windows Job Objects own
compiler descendants. Bundled tools are checksum/version verified; external tools
require explicit configuration and compatibility checks. Tool preparation is a
separate explicit development operation. Opening a workspace never acquires tools
or restores dependencies.

The frontend has no unrestricted filesystem/shell plugin permission. Its capability
is local to the main window, with core/window permissions required for ordinary
operation and confirmed shutdown. Production CSP restricts connections to local
resources/data and Tauri IPC; scripts permit bundled JavaScript and WebAssembly,
and styles permit the inline variables required by the editor. Development CDP
is enabled only by the test launcher, never application code. Editor telemetry and
experiments are disabled.

Custom themes are bounded, validated JSON. Supported hex color tokens and syntax
rules are copied into the shell/editor configuration; executable content, resource
URLs and arbitrary CSS values are not accepted. Tool output is displayed verbatim
as text. The application does not add credentials or environment dumps to logs.

## Evidence and remaining release work

`node scripts/security-smoke.mjs` bypasses frontend checks and invokes real native
commands against disposable fixtures. It verifies forged picker/history requests,
outside reads/writes/listing/project inspection/creation/watch/search overlays,
root/Git protection, invalid names, a Windows junction escape, stale LSP IDs,
settings/history separation and revocation across workspace changes. Its outside
sentinel remains unchanged and no external WebView request is observed.

Core tests additionally cover path traversal, atomic no-overwrite, encoding,
framing limits, blocked-pipe shutdown, process limits/descendant cancellation and
Recycle Bin restoration. Native Search, Explorer, language, build and theme smoke
tests verify corresponding user workflows.

Installed-release CSP, bundled tool placement and the full install/edit/build
workflow remain part of release verification. The planned dependency-management
workflow introduces explicit acquisition and must receive its own source/checksum,
destination, execution and cancellation review before shipping.
