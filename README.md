# ompide

ompide is a desktop editor for Pawn, built for open.mp projects. Write your
scripts, find your way around a codebase, build an AMX, and manage your Git
changes without leaving the editor.

The name combines OMP, from open.mp, with IDE.

The project is still in development. Windows x64 is the current tested platform;
Linux and macOS support will come later. Installer testing is not finished yet,
so for now, [build and run it from source](https://github.com/AmyrAhmady/ompide/wiki/Building-from-Source).

## What it does

- **Pawn editing:** completion, diagnostics, hover information, signature help,
  go to definition, references, rename, symbols, and formatting through
  [pawnlsp](https://github.com/pawnkit/pawnlsp).
- **Project builds:** compile with the
  [open.mp compiler](https://github.com/openmultiplayer/compiler), choose an
  entry point or named build, and jump from a compiler error to its source.
- **Files and search:** tabbed editing, recent files and folders, a project
  explorer, workspace search, and replacement previews before changing files.
- **Git:** working and staged diffs, staging, commits, amend and undo, branches,
  tags, stashes, push, and pull using your installed Git.
- **Terminal:** multiple shell sessions in a tabbed bottom panel alongside
  Problems and Build Output. Hiding the panel keeps your sessions running.
- **Your setup:** Light and Dark themes, custom JSON themes, adjustable panels,
  and saved editor preferences.

The editor uses [Monaco](https://microsoft.github.io/monaco-editor/) inside a
[Tauri](https://tauri.app/) desktop application, with React and TypeScript on the
frontend and Rust handling files and processes. Pawn language features come from
PawnKit, including its formatter and linter through pawnlsp. The interface is
currently available in English.

## Getting started

Once the application is running:

1. Open your project folder from **File → Open Folder…**.
2. Open a `.pwn` or `.inc` file in the Explorer.
3. Use **Build → Configure Project…** to check the entry point, target profile,
   and include folders.
4. Press **Ctrl+Shift+B** to compile. Compiler messages appear in the bottom
   panel, with links to the relevant files and lines.

Existing `pawn.json`, `pawn.yaml`, and `pawn.yml` configurations are supported.
If your project does not have one, Configure Project can help you create it.
Include libraries need to be installed separately. Opening a folder does not
download tools or dependencies.

Press **F1** or **Ctrl+Shift+P** to find commands. **Ctrl+P** finds files,
**Ctrl+Shift+F** searches the workspace, and **Ctrl+,** opens Settings.

## Documentation

- [Building from source](https://github.com/AmyrAhmady/ompide/wiki/Building-from-Source): prerequisites, tool preparation, development,
  and packaging commands.
- [Project wiki](https://github.com/AmyrAhmady/ompide/wiki): user guides for
  projects, editing, Git, terminals, themes, and workspace trust. The pages are being prepared and
  have not been published yet.
- [Toolchain notes](toolchain/README.md): pinned versions, checksums, licenses,
  and compatibility details.

## Current limitations

The Windows compiler workflow currently requires ASCII paths for projects,
compiler files, and include folders. The editor supports UTF-8, UTF-16, UTF-32,
and common legacy encodings. Click the encoding in the status bar to reopen or
save with a different encoding. Existing LF and CRLF line endings are preserved,
and saves that would lose characters are refused.

Text files can be up to 128 MiB on disk or after decoding to UTF-8. Files at
8 MiB or four million editor characters use a lighter mode without language
analysis or syntax highlighting. Workspace content search and Git comparisons
have separate 8 MiB limits; large files can still be found by name and opened.
Encoding support in the editor does not change what the selected Pawn compiler
accepts.

Git pull is fast-forward only. Debugging and running a game server are not part
of the current build.

## Contributing

Bug reports and contributions are welcome. When
[reporting a problem](https://github.com/AmyrAhmady/ompide/issues), include
your Windows version, what you were trying to do, and the steps needed to
reproduce it. A small example project helps with compiler and language problems.
Remove passwords, tokens, and private server details before sharing files or logs.

For code changes, start with [the build guide](https://github.com/AmyrAhmady/ompide/wiki/Building-from-Source) and run the checks relevant to
your change. Keep dependency lockfiles up to date, and include a brief explanation
of what changed and how you tested it.

## Donations

If you find the project useful and would like to support its development, you can
[donate here](https://donate.amii.ir).
