ompide {version} — Linux x64 (Debian/Ubuntu)

This ZIP contains a .deb installer with ompide, pawnlsp, the open.mp compiler,
its shared library, and third-party notices. macOS is not included.

On Ubuntu 22.04 or newer, enable the compiler's 32-bit libc dependency once:

  sudo dpkg --add-architecture i386
  sudo apt update
  sudo apt install ./ompide_*.deb

Use the actual .deb filename from this ZIP. Start ompide from your application
menu or run `ompide` in a terminal. GTK/WebKitGTK and 32-bit libc are system
packages resolved by apt. Git is optional, for Source Control.

The app is x64; the pinned upstream open.mp compiler is 32-bit. Its private
libpawnc.so is included. Library lookup is scoped to compiler subprocesses.

This is the initial Linux CI package. Successful compilation and automated
startup do not replace testing the editor, terminal, desktop integration and
file dialogs on a real Linux desktop. Other distributions are not yet verified.
