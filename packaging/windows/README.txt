ompide {version} — Windows x64

Extract the entire ZIP into a folder, then run ompide.exe. Keep pawnlsp.exe,
binaries/ and licenses/ beside the application. The editor frontend is embedded;
Node.js, Rust and Go are not needed to run this build.

Windows prerequisites

- Windows 10 or 11, x64, with Microsoft Edge WebView2 Runtime installed.
  WebView2: https://developer.microsoft.com/microsoft-edge/webview2/
- Install Git for Windows to use Source Control. Git is not bundled.
- Terminal sessions use a shell already installed on your computer.

The included open.mp compiler is 32-bit. Its compiler DLL and the required x86
Microsoft Visual C++ runtime are included in its bin folder. Your project's
include files and libraries are not supplied or downloaded automatically.
The compiler currently requires ASCII-only project/compiler/include paths.

This is an extract-and-run distribution, not an installer. Settings and recent
files are saved in %APPDATA%\mp.open.editor. Updating the app means extracting
the complete new ZIP into a new folder; avoid mixing files from different builds.

Project and guides: https://github.com/AmyrAhmady/ompide
Wiki: https://github.com/AmyrAhmady/ompide/wiki
Issues: https://github.com/AmyrAhmady/ompide/issues

Project-owned source is licensed under MPL 2.0. See LICENSE and the bundled
licenses/ and binaries/licenses/ notices for the application and third-party tools.
release-manifest.json records the build version, source commit and file hashes.
