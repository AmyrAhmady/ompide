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

- pawnlsp v0.34.47: `f1dc60d60edcff555f716413cdc8099e64c0e129`, MIT.
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
diagnostics and removal of stale AMX artifacts. The UI/Tauri channel is not yet
proven by this harness.

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
package alignment and native channel behavior still require verification.
