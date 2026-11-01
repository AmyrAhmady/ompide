ompide {version} — Linux x64 portable archive

Extract the entire ZIP into a folder, then run:

  ./ompide

The top-level launcher finds the application and its resources relative to
itself. Keep the usr folder next to it. No installation or administrator
permissions are needed to run ompide once system dependencies are installed.
If your archive manager removed executable permissions, restore them on
ompide, usr/bin/ompide, usr/bin/pawnlsp and the compiler under
usr/lib/ompide/binaries/compiler/*/bin/pawncc.

System requirements

The app needs GTK 3 and WebKitGTK 4.1. The bundled upstream open.mp compiler
is 32-bit and needs 32-bit libc even though ompide and pawnlsp are x64.
Git is optional, for Source Control. The ZIP includes pawnlsp, the compiler,
its private shared library, third-party notices, and a file checksum manifest.
System GTK/WebKit/libc libraries are not bundled.

On Ubuntu 22.04 or newer:

  sudo dpkg --add-architecture i386
  sudo apt update
  sudo apt install libgtk-3-0 libwebkit2gtk-4.1-0 libxdo3 libc6:i386

On Arch Linux, enable the multilib repository, then install:

  sudo pacman -S gtk3 webkit2gtk-4.1 libxdo lib32-glibc

Separate .deb and Arch .pkg.tar.zst packages are also produced by CI. Install
those with apt or pacman respectively. The Arch package requires multilib too.

The portable archive is built on Ubuntu 22.04. CI checks extraction, tool
execution and native startup on Ubuntu; the Arch package is installed and
checked separately in an Arch container. Interactive desktop testing and
other distributions still need verification. macOS remains deferred.
