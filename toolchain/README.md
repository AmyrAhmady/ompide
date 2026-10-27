# Verified toolchain

`tools.json` pins the Windows x64 release archives and executable hashes. Binaries
and archive caches are ignored by Git. Preparation is an explicit development or
release operation, never an application startup or workspace-open hook:

```powershell
node scripts/prepare-tools.mjs --download
```

The command prints each GitHub release source and verifies SHA-256 before
extraction. Without `--download`, it uses only the cached archives in
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

- pawnlsp 0.34.47 crashes during rapid typing with an index-out-of-range panic in
  pawn-analysis 0.30.24 `preprocess.directiveRange`/`reuseCompatibleContext`.
  Pin 0.33.75, which predates the incremental workspace expansion reuse and passes
  both protocol and desktop typing tests. Do not update it without rerunning them.
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
