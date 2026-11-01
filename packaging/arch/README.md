# Arch Linux package

CI produces `ompide-<version>-1-x86_64.pkg.tar.zst` and its SHA-256 checksum.
Enable the multilib repository first: the bundled open.mp compiler needs
`lib32-glibc`. Then install the downloaded package:

```sh
sudo pacman -U ./ompide-*.pkg.tar.zst
```

The package installs the app, language server, compiler, shared library,
application-menu entry, icons and license notices. Git is optional.

`PKGBUILD.in` is the checked-in recipe template. CI replaces its version,
Debian payload checksum, license checksum and data-archive name with verified
values, then runs makepkg as an unprivileged user. The binaries are built on
Ubuntu and are preserved unchanged; Arch checks installation and native startup
against current system packages. This is a downloadable package, not an AUR
publication.

The generated `PKGBUILD` is uploaded for inspection. To use it manually, supply
the matching Debian artifact as `ompide.deb` and the project's `LICENSE` beside
it, then run `makepkg`. Its exact checksums must match. No Rust rebuild is needed.
