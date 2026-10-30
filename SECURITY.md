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

Builds invoke the pinned open.mp compiler directly with an explicit argument
array, selected entry and scoped working directory/output. Local JSON/YAML
configuration is validated before compilation; response files and options that
redirect writes or select alternate input/output modes are rejected. Compiler
exit status and a real 32-bit AMX header are checked before declaring success.
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
workflow remain part of release verification. The approved release does not
provide project dependency installation/restoration or runtime/server management.
Source Control resolves an absolute installed Git executable before entering a
workspace, strips inherited Git override variables, disables fsmonitor during
inspection, uses NUL-separated status and literal path arguments, and rejects
links/traversal for file actions. A workspace inside a larger repository must open
the repository root before using Git. Repository snapshots detect changed HEAD,
index entries, branch/tag names and stashes before a requested action. Status is an observation,
not an exclusive lock against external Git clients; Git still owns repository locks.

Only explicit Git actions invoke mutations or network operations. Git hooks,
filters, signing and credential helpers follow the user's Git configuration when
an action is explicitly invoked. There is no automatic fetch, pull, push or tool
download. Subprocesses have time/output limits and descendant cancellation.
Working-tree mutations refuse dirty editor buffers, retain raced edits during
reconciliation, and invalidate the selected build configuration. Cancelled or failed
operations refresh actual state and never claim automatic rollback.

Core real-Git tests cover ordinary/renamed/deleted/untracked/conflicted states,
index/working diffs, paths/refs, stashes, local bare-remote push/pull and dirty-file
switch refusal. `scripts/git-smoke.mjs` verifies the real native controls, unsaved
buffers, confirmation flows and cancellation during a configured hook. External
credential dialogs for a fresh login and installed-release Git behavior remain
manual checks. Cached GitHub authentication and a private-repository HEAD query
have been verified read-only, with credentials and private URLs excluded from
reports. `scripts/git-auth-smoke.mjs` exercises real native Git/GCM against a
loopback smart-HTTPS backend and disposable DPAPI store, including failures and
cancellation. Its per-repository certificate trust never changes OS/global trust.
IDE-owned Git disables GCM credential tracing and secret tracing, even when a
workspace enables those settings; ordinary raw Git failure output is retained.
