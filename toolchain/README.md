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
Windows x64 Go 1.26.5, Git and tar. Compiler selection checks an explicit
`OMPIDE_GO` override first, then compatible `go.exe` installations on `PATH`, then
the checksum-pinned distribution in `.tools-cache/go1.26.5/`. A normal system Go
installation needs no environment override. Every candidate must report exactly
`go1.26.5 windows/amd64`; an invalid explicit override fails rather than silently
selecting another compiler. The cached compiler additionally requires its pinned
checksum. `GOTOOLCHAIN=local` prevents automatic compiler downloads. Go is a
development prerequisite and is never bundled or downloaded by preparation.

`--download` explicitly permits downloading the pinned source and Go module
dependencies; the default is offline. The two `golang.org/x` dependencies use their
official GitHub mirrors because the vanity/source host was unavailable here. Their
complete source trees must match the original canonical module checksums, in
addition to Go's normal module verification. Versions and sources remain pinned.

```powershell
# Uses compatible Go from PATH; OMPIDE_GO is an optional explicit override.
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

Rust reads local JSON/YAML configuration and invokes the pinned
openmultiplayer/compiler directly. There is no unified CLI wrapper or automatic
compiler/dependency acquisition. Existing manifest names are preserved for the
language server. Named builds inherit input, arguments, includes and constants.

The supported compiler arguments and diagnostic syntax were checked against
[openmultiplayer/compiler v3.10.11](https://github.com/openmultiplayer/compiler/tree/v3.10.11),
commit 38e9795439fff218fae5096d43c468acc2e513a1, particularly
source/compiler/sc1.c and source/amx/amx.h. Rust builds explicit argument arrays,
uses the project working directory and owns output/<entry-name>.amx. Diagnostic
file(line) messages become scoped file URIs and zero-based line locations; raw
stdout/stderr remain visible. Exit status and the 32-bit AMX header/size are
verified. Failure/cancellation removes stale or partial output. Response files,
extra input files and write-redirection/working-directory/non-AMX-output options
are rejected. Compilation is a trusted tool operation, not an OS sandbox.

Compiler output is displayed at completion. Rust owns output/time limits and
Windows Job Object cancellation; editing remains available. The Windows compiler
uses ANSI paths: the app explicitly rejects unsupported non-ASCII project,
compiler, entry and include paths. JSON/YAML parsing no longer depends on a CLI
loader or its YAML schema-version limitation. These checks never rewrite an
existing manifest or install dependencies.

Run the explicit real compiler/core integration test after preparing the tools:

    cargo test --manifest-path src-tauri/Cargo.toml -p pawn-core --test compiler_integration -- --ignored

It verifies actual success, includes/constants, compiler diagnostics, failure and
stale/cancelled artifact cleanup. The ordinary offline unit suite does not require
the compiler. The separately ignored Explorer test is a disposable Recycle Bin
restoration helper invoked only by the Explorer smoke script.

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
worker URLs in optimized dependency code. The base PawnKit TextMate grammar and
configuration come from vscode-pawn commit
`4a03c390a29a86fdf503be05eabf2fd345caa339`, with its MIT license included.

Selected grammar rules are adapted from
[openmultiplayer/vscode-pawn](https://github.com/openmultiplayer/vscode-pawn/blob/c9da1136bbdaf643ed5d3b100b40480638aecf76/syntaxes/Pawn.tmLanguage)
at commit `c9da1136bbdaf643ed5d3b100b40480638aecf76`: format placeholders,
logical-line macro contexts and parameters, stringification/token pasting,
comment annotations, numeric separators/ranges, and richer directive handling.
The adaptations retain Pawn scope names and caret/backslash escapes, recover
highlighting after unterminated literals, and avoid the old grammar's C/C++
numeric suffixes and dangling includes. Grammar colors remain theme-controlled;
these rules do not replace compiler or language-server diagnostics. Upstream
attributions and MIT terms are retained in `src/editor/pawn/LICENSE.txt`, which is
included in the release ZIP. Run `npm run test:grammar` for actual TextMate and
Oniguruma tokenization tests and `node scripts/syntax-smoke.mjs` for rendered
Light/Dark/custom-theme checks. Both use the editor's existing pinned engines.

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

## Integration scope

The first release bundles pawnlsp and openmultiplayer/compiler. Formatting and
linting remain available through pawnlsp and its internal pawnfmt/pawnlint,
analysis/parser/API/project/core libraries. Project dependency management and
server tools are excluded. Pawndebug is planned for a future release after the
first release; no DAP implementation is currently included.

## VS Code color themes

Theme files now use VS Code JSON/JSONC rather than an ompide schema. The parser
accepts standard UI color identifiers, TextMate scope arrays and font styles,
semantic selectors and high-contrast types. Existing saved base/schemaVersion
preferences are migrated when read. Light/Dark and the Ocean example use the
standard format. Shell surfaces derive from VS Code tokens; unsupported UI
surfaces have no effect. Neutral editor bases keep imported token rules separate
from ompide's built-in Pawn colors.

The picker supports local JSON, extension folders and VSIX packages. Includes
resolve against supplied files only. jsonc-parser 3.3.1 parses comments/trailing
commas; fflate 0.8.2 extracts bounded theme resources without registering or
executing extensions. The installed library is saved with ordinary preferences.
Preview is separate transient state and never changes persisted selection.

Online search uses the documented Open VSX API, category Themes, limited to
30 results. Search and download require explicit actions, omit credentials and
referrers, enforce response/time limits and check the downloaded package against
the registry SHA-256. Production CSP permits only open-vsx.org and its content
host openvsx.eclipsecontent.org in addition to existing local connections. No
Microsoft Marketplace API is used; see Microsoft's VS Code FAQ and the Open VSX
Registry API documentation. There is no automatic theme update or general
extension marketplace.

Run npm test for parsing/include/package/registry regressions,
node scripts/vscode-theme-smoke.mjs for picker rendering and a live registry
round trip, and node scripts/vscode-theme-native-smoke.mjs after a debug packaged
build for real WebView CSP and preferences/reload. The latter owns a temporary
application instance and restores the user's preferences.
