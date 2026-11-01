# Verified toolchain

`tools.json` pins Windows x64 executable hashes, release archives for the compiler,
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

The bundled server is `0.33.75-pawnide.3`, based on the upstream v0.33.75 commit
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

Version `.3` also pins the macro-expansion fix from
[`AmyrAhmady/pawn-analysis`](https://github.com/AmyrAhmady/pawn-analysis/commit/e928673f7577cb4e93a197a6cd3bfb87f0809998),
commit `e928673f7577cb4e93a197a6cd3bfb87f0809998`, through Go replacement version
`v0.0.0-20261101092659-e928673f7577`. Its module checksums and the required
`pawn-parser` v1.5.11 update are included in the verified source patch. This
corrects punctuation-bearing macro patterns and adjacent token substitution,
which otherwise inflate native parameter counts in the open.mp includes. All
existing overlay and lifecycle fixes remain. Builds fetch the immutable module
through normal Go resolution; a local fork checkout is unnecessary. Switch back
to an upstream dependency release once it includes the fix.

`pawnlsp-build.json` pins source/patch checksums, the minimum Go version and the
compiler used for reproducible official releases. The pinned upstream go.mod
requires **Go 1.26.5 or newer**. Normal local preparation accepts newer stable Go
versions; Go 1.27.3 passed the upstream tests and our real LSP integration checks.

`scripts/build-pawnlsp.mjs` verifies source and patch checksums, checks that the
recorded minimum agrees with upstream go.mod, verifies canonical dependency trees,
runs upstream tests and builds with CGO disabled, trimmed paths and an empty build
identifier. The compiler is the normal `go` command on PATH. There is no private
Go environment variable or cached-compiler fallback. An optional `--go <path>`
selects a compiler explicitly when reproducing a release. GOTOOLCHAIN=local prevents automatic compiler downloads. Neither
opening workspaces nor preparation downloads Go itself.

Go uses its normal `GOPATH`, `GOMODCACHE` and `GOCACHE` defaults or your configured
values; preparation does not redirect these into `.tools-cache`. Module paths
come from `go mod download -json`, including Go's module-name escaping. With
`--download`, your Go proxy and checksum-database settings are preserved, including
settings stored by `go env -w`. Without it, module network access is disabled.
The project's `.tools-cache` still holds verified source archives and temporary
source staging, which are separate from Go's own caches.

Different compiler versions produce different executables. Local builds record
the actual checksum, compiler version, source/patch identity and target in the
pawnlsp dependency-notice index. The application validates that provenance at
build time and embeds the expected checksum; runtime verification still rejects a
changed executable. A workspace or runtime-edited metadata file cannot change
that compiled expectation. A valid prepared binary needs no Go installation.

Official release CI adds `--reproducible`: it retains exactly Go 1.27.3 and the
pinned executable hash in tools.json. The release ZIP verifier still rejects other
hashes. To reproduce an official package, use the same flag locally; ordinary
development builds do not need that compiler version.

`--download` explicitly permits downloading the pinned source and Go module
dependencies; the default is offline. Dependencies use their original upstream
module paths and go.sum through normal Go proxy resolution. Preparation runs
`go mod verify` after the upstream tests. There are no network-specific module
replacements for this development machine; source and dependency versions stay
pinned.

```powershell
# Uses the installed Go command on PATH.
npm.cmd run tools:build-lsp -- --download
# Force a local rebuild with the selected compatible compiler:
npm.cmd run tools:build-lsp -- --rebuild
# Reproduce the official pinned binary (requires release compiler):
npm.cmd run tools:build-lsp -- --rebuild --reproducible
```

The shipped notices include PawnKit's MIT license and the Go BSD license.

Build-script discovery also uses npm's standard invocation metadata or the npm
command on PATH, and the Visual Studio developer-shell configuration or vswhere
to locate C++ redistributables. It does not assume an npm directory beside Node
or cap supported Visual Studio installation versions.

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

Packaging and real-tool verification obtain Cargo's target directory through
`cargo metadata`, honoring CARGO_TARGET_DIR and Cargo configuration. If both native
and explicit-target builds exist, packaging requires `--executable <path>` to
avoid silently choosing a stale build. This option is otherwise unnecessary.


## Linux x64 CI

`.github/workflows/linux-build.yml` builds on Ubuntu 22.04 independently of the
Windows workflow. Pushes to master, version tags, pull requests and manual runs
produce a ZIP containing a Debian installer, installation instructions, license
and a checksum manifest. macOS and other Linux package formats remain deferred.

The workflow prepares tools, checks the frontend and Rust code, runs real LSP
and compiler tests, builds a `.deb`, verifies its extracted contents, installs it
and checks that a native window opens under Xvfb. This startup check does not
replace interactive testing on a Linux desktop.

`toolchain/tools-linux.json` pins the official open.mp compiler archive,
executable and `libpawnc.so` checksums. The upstream compiler is 32-bit even
though ompide and pawnlsp are x64. Debian/Ubuntu therefore needs the i386
architecture enabled and `libc6:i386`; the installer declares that dependency.
Only compiler subprocesses receive the bundled library lookup path.

The Linux language server uses the same pinned source, patch and analysis fix
as Windows. CI uses the release Go version in `pawnlsp-build.json`. Its first
binary checksum is not known before the first Linux build: the source build
records it with source/patch/compiler provenance, the application embeds it,
and packaging verifies the receipt and shipped executable agree. A fixed
Linux binary checksum can be pinned after a verified reproducible CI build.
The existing fixed Windows checksum remains enforced.

CI runs `npm run tools:prepare -- --download --reproducible`, then
`npm run release:linux:notices`, Tauri's Debian build, and
`npm run release:linux:package`. The final installed startup check is
`xvfb-run -a npm run release:linux:smoke`. No Linux build is required locally.
