# Verified toolchain

`tools.json` pins Windows x64 executable hashes, release archives for the CLI/compiler,
and the source build for the patched language server. Binaries
and archive caches are ignored by Git. Preparation is an explicit development or
release operation, never an application startup or workspace-open hook:

```powershell
node scripts/prepare-tools.mjs --download
```

The command verifies SHA-256 before extracting release assets or building pinned source. Without `--download`, it uses only the cached archives in
`.tools-cache/` and fails with manual-placement guidance when they are missing.
Windows `tar` must be installed. Other targets are not yet verified.

License texts are copied from the pinned upstream sources:

- pawnlsp v0.33.75: `bffabaa538c3b290fe22ccfbb61c3a4558af2a33`, MIT.
- pawnkit-cli v1.34.38: `bacacd60b442e7602533fe07a72a1bf33caf0a2f`, MIT.
- openmultiplayer/compiler v3.10.11: `38e9795439fff218fae5096d43c468acc2e513a1`, Zlib.

The compiler archive and executable checksums match the pinned PawnKit compiler
index identified in `tools.json`. PawnKit archive hashes were also checked against
each release's `checksums.txt`. Only `pawncc.exe` and its required `pawnc.dll` are
prepared from the compiler archive. The license texts must accompany packaging.

## Patched language server

The bundled server is `0.33.75-pawnide.2`, based on the upstream v0.33.75 commit
listed above. It remains the real PawnKit executable over standard LSP. The patch
in `patches/pawnlsp-open-overlays.patch` makes document analysis use unsaved include
buffers, invalidates affected open parents on include open/change/close, and
includes declarations from included files in workspace-symbol results. It never
writes unsaved buffers to disk. The regression fails on the original server and
passes with the patch; the full upstream Go suite also passes. Version `.2` also
disables unsafe compatible-expansion reuse for workspace entry analysis in
pawn-analysis 0.30.3. Without that change, a cached valid entry can keep returning
no argument-count diagnostic after an invalid edit, or retain an error after a
correction. Token caching, trivia reuse, debounce and background analysis remain
enabled. A synchronous workspace-analysis regression fails before this fix;
real protocol tests cover repeated full-text and full-range valid/invalid edits.

`pawnlsp-build.json` pins source/patch checksums and development compiler provenance.
`scripts/build-pawnlsp.mjs` extracts a fresh verified source archive, applies the
patch, runs the upstream tests and builds with Go 1.26.5, CGO disabled, trimmed
paths and an empty build identifier. The final executable must match the hash in
`tools.json` before it replaces the prepared sidecar. Fresh source builds reproduce
the pinned hash. The original prototype differed only in Go's action build IDs;
those are omitted from the distributed build.

A cached matching executable requires no Go installation. Rebuilding requires
Windows x64 Go 1.26.5, Git and tar. Set `PAWN_IDE_GO` to an explicitly selected
`go.exe`, or extract the checksum-pinned GitHub Actions Go distribution identified
in `pawnlsp-build.json` into `.tools-cache/go1.26.5/`. The cached compiler executable
is checked before use. Go is a development prerequisite and is never bundled with
the application or downloaded by the preparation script.

`--download` explicitly permits downloading the pinned source and Go module
dependencies; the default is offline. The two `golang.org/x` dependencies use their
official GitHub mirrors because the vanity/source host was unavailable here. Their
complete source trees must match the original canonical module checksums, in
addition to Go's normal module verification. Versions and sources remain pinned.

```powershell
$env:PAWN_IDE_GO = 'C:\Go\bin\go.exe'
npm.cmd run tools:build-lsp -- --download
# Reproduce from cached source/dependencies, including the full upstream tests:
npm.cmd run tools:build-lsp -- --rebuild
```

The shipped notices include PawnKit's MIT license and the Go BSD license.

## Protocol and compiler verification

```powershell
cargo test --manifest-path src-tauri/Cargo.toml -p pawn-core
cargo clippy --manifest-path src-tauri/Cargo.toml -p pawn-core --all-targets -- -D warnings
cargo build --manifest-path src-tauri/Cargo.toml -p pawn-core --bin pawn-lsp-bridge
node scripts/verify-tools.mjs
```

These commands build only the small process/framing crate, without compiling the
Tauri application. Offline unit tests require no Pawn tools. The explicit
integration command requires the prepared tools and bridge harness and fails if
they are missing. It tests the real server and compiler, writes local evidence
to `test-results/tool-integration.json`, and removes its temporary workspaces.

Verified on Windows x64: incremental LSP synchronization (kind 2), UTF-16 default
encoding, CRLF, surrogate pairs, spaces/emoji/hash characters in LSP file URIs,
completion, cross-file definition, real diagnostics, whole-document formatting,
save/close/shutdown/exit, successful compilation and failed compilation with
diagnostics and removal of stale AMX artifacts.

The separate `node scripts/native-smoke.mjs` checks the real desktop UI/Tauri
channel, completion popup, F12 navigation, typing/save/undo, cancel/discard/reopen,
Problems delivery and persisted Light/Dark switching. It requires Vite and the
debug application started with an explicit loopback WebView2 CDP port 9222. It
temporarily backs up/restores application preferences and uses disposable fixture
copies. Screenshots go to `test-results/`. It does not verify native file picker
interaction, installed packaging, or all remaining plan gates.

`pawn project --output json` and `pawn doctor --output json` use schema 1.
`pawn build --format json --compiler ABSOLUTE_PATH --artifact OUTPUT_PATH` uses
schema 2, including status, process output/exit code, diagnostic locations and
artifacts. An explicit artifact path is required for this fixture. Always supply
an existing compiler path: the CLI can otherwise download a compiler. The CLI
captures compiler output and emits the JSON report at the end; progress must not
pretend that this is live line-by-line compiler output.

Known upstream limitation: the pinned Windows compiler uses ANSI paths and fails
when an entry path contains emoji (observed as `??` in its error output). LSP
handles these paths correctly. Building such projects needs an explicit
actionable error or a verified path workaround before claiming full support.

The native build workflow always supplies the checksum-verified bundled
openmultiplayer/compiler 3.10.11 (or an explicitly chosen compatible executable),
an explicit artifact path under the selected project's `output/` folder, and
the selected profile/named build. It never selects a custom backend, runs a
runtime server, or invokes automatic compiler acquisition. Windows Job Object
ownership terminates compiler descendants on cancellation and application exit.
Compiler output is buffered by the pinned CLI and displayed when it returns.

The pinned CLI's YAML loader validates `pawnkit.schemaVersion` as a JSON
floating-point value although YAML decodes `1` as an integer. Consequently YAML
manifests using this extension are rejected upstream. Basic YAML manifests with
`preset`/`include_path` and build selections work; use `pawn.json` for PawnKit
extension settings. The IDE reports this limitation explicitly and never rewrites
a user's manifest automatically. Source: pawn-project v0.34.2,
`manifest/load.go` and `manifest/validate.go` (`checkPawnKit`).

`node scripts/build-smoke.mjs` exercises the actual native Build UI. Use the same
temporary CDP/Vite setup as the desktop smoke test, and prepare the official
open.mp fixture first. It uses disposable projects, restores preferences and
closes its test application; evidence is saved under `test-results/`.

Browser integration is based on TypeFox monaco-languageclient 11.0.3 and its
current upstream compatibility table: Codingame API/editor 37.6.0 (Monaco 0.57.0),
VS Code language client 10.1.2. Use the standard MessageTransports reader/writer
contract over Tauri Channels/commands, without a network listener. Browser
package alignment and native channel behavior were verified in the desktop smoke
test. Vite worker imports are owned by `src/editor/workers.ts` to avoid broken
worker URLs in optimized dependency code. The PawnKit TextMate grammar and
configuration come from vscode-pawn commit
`4a03c390a29a86fdf503be05eabf2fd345caa339`, with its MIT license included.

## Compatibility workarounds

- Disable experimental asynchronous TextMate tokenization in the pinned editor
  packages. A large document edit followed by a theme change can apply undefined
  worker state deltas (`Cannot set null/undefined state`). The standard tokenizer
  retains syntax highlighting and passes real typing/theme stress checks.
- A busy language server may exceed the client's graceful shutdown timeout.
  Continue closing only after Rust's explicit stop has killed and waited for the
  owned process. Native cleanup failures still propagate; a handled graceful
  timeout cannot veto a confirmed discard/exit or workspace switch.
  Pipe writes run on the blocking pool with a separate stdin lease, outside the
  process-ownership mutex. Stop kills/waits for the child before taking the stdin
  lock, releasing a writer stalled on an unread pipe. A core regression uses a
  deliberately non-reading child; real large-document typing/exit checks cover
  the native IPC path. The frontend still serializes writes and preserves framing.

- Production CSP needs `data:` in `connect-src`: the editor API registers our
  bundled grammar and theme contents as data URLs and fetches them as resources.
  This permits local data fetches without adding external network hosts or
  executable data scripts. Production-assets smoke tests catch failures that
  Vite development mode does not expose.
- Keep the shell header class distinct from VS Code API stylesheet classes.
  `.menubar` can inherit clipping from upstream CSS; use `.ide-menubar` with
  explicit stacking and visible overflow. Tab activation must focus the editor
  so subsequent keyboard input reaches the selected document.
- pawnlsp 0.34.47 crashes during rapid typing with an index-out-of-range panic in
  pawn-analysis 0.30.24 `preprocess.directiveRange`/`reuseCompatibleContext`.
  Pin 0.33.75 with the local workspace-reuse fix described above. That older
  release also has compatible-expansion reuse; do not assume a version pin alone
  prevents stale diagnostics. Do not update it without rerunning protocol,
  desktop typing and diagnostic-clear regressions.
- PawnKit compares serialized file URI identities in some diagnostic paths. Use
  standard client URI converters to agree with native/PawnKit file URLs, including
  uppercase Windows drive letters and literal drive colons, while preserving URL
  encoding of spaces, Unicode, hash and percent characters. Monaco model URIs
  remain stable and are converted at the protocol boundary.
- The pinned server retains query versions after `didClose`. Restart the session
  before reopening a disposed URI whose Monaco version restarts at 1. All remaining
  unsaved buffers stay in memory and reopen in the new session. This costs a reindex
  on explicit reopen and can be removed after an upstream fix is verified.
- VS Code managed text-file references retain dirty models. Soft-revert their
  managed dirty state after a successful native save (only if no edit raced the
  save), and before disposing a confirmed closed/discarded model. The IDE retains
  its own captured saved-version tracking so edits during an in-flight save stay
  dirty. Disk writes remain exclusive to scoped Rust commands.
- pawnlsp 0.33.75 can retain an empty project graph after an entry file is removed
  and restored. Restart on open-file presence transitions or watcher overflow;
  preserve and reopen all unsaved models. Ordinary disk writes use standard
  watched-file notifications without restarting the server. Presence-transition
  notifications are still forwarded after a restart and after initial opens
  settle, so project reload sees the restored files and current unsaved buffers.
- Serialize document changes above the transport. VS Code's pending initial
  opens can otherwise race edits when restarting with background documents.
  Explicitly flush public didOpen providers, order changes/requests/save/close,
  and cancel retired-session requests during shutdown. The desktop smoke checks
  real diagnostics after reopen, conflicting external changes and rename/restore.

## Dependency command contract

Reviewed against pawnkit-cli **v1.34.38**, commit
`bacacd60b442e7602533fe07a72a1bf33caf0a2f`, and pawn-project **v0.34.2**,
commit `14c28fb0fedb0bf4b6be647b6b17fd1e94061b04`. Sources:
`pkg/cli/{install,restore,dependency_cache}.go` in
[pawnkit-cli](https://github.com/pawnkit/pawnkit-cli/tree/v1.34.38/pkg/cli), and
`dependency` / `lockfile` in
[pawn-project](https://github.com/pawnkit/pawn-project/tree/v0.34.2).

- `pawn restore --project DIR --format json` restores locked source revisions
  and locked resources for the host target. It requires a lockfile; it does not
  resolve new dependencies or rewrite the lock. Never pass `--backend`.
- `pawn install --project DIR --format json` may resolve the graph, write source
  records, acquire sources, resolve release assets and update resource records.
  `--update` explicitly refreshes revisions. Installation can change source
  records as well as the PawnKit resource section.
- Both return schema 1: `dependencies` contains `{name,path,status}`, where status
  is `installed`, `present` or `local`. Optional `resources` contains
  `{package,resource,target,files}`. Paths can use forward slashes on Windows.
  Failure can return only stderr, after partial changes have already been made.
- Source restoration uses Git on PATH, credential-free HTTPS URLs, locked commits
  and optional directory SHA-256 integrity. It uses the shared OS cache under
  `pawnkit/pawn-project/dependencies`. Missing cached sources may require network
  access. There is no `restore --offline` switch. Existing verified clean
  checkouts or a populated cache can work offline; assets are fetched and verified
  against locked archive/file sizes and checksums.
- Remote source targets are `dependencies/<repo>`, not `<owner>/<repo>`.
  Check collisions case-insensitively on Windows. Local sources stay at their
  declared paths. Directory existence does not prove that a checkout is verified.
- Locks can use `schemaVersion: 1` plus `packages`/`resources`, or sampctl's
  `version: 1` plus `dependencies` and optional
  `pawnkit: {schema_version: 1, resources: [...]}`. Respect `pawnkit.lockfile`
  in the manifest. Core review reports saved inputs, commits, checksums, asset
  targets and destinations without running tools or writing files. It does not
  replace PawnKit semantic validation or authorize a later acquisition. Recheck
  revisions, scope and dirty buffers before execution.

`npm run test:dependencies` exercises the prepared pinned CLI against disposable
local sources in both lock formats, with unchanged inputs and no acquisition.
Core tests cover read-only review, path/junction rejection, source identity and
limits. Dependency execution remains a separate unfinished milestone.
