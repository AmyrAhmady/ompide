This real open.mp project exercises official native declarations, callbacks,
Float tags, nested includes, include guards and macros across multiple files.
It has no build scripts, plugin downloads or runtime-server requirement.

Run `npm.cmd run fixtures:prepare -- --download` explicitly once, or provide the archive
listed in `toolchain/fixtures.json` in `.tools-cache/` and run without the flag.
The script verifies the pinned source archive checksum, copies unmodified `.inc`
files and the upstream MPL-2.0 license into ignored `.vendor/omp-stdlib/`, and
does not execute anything from the downloaded repository. Opening this fixture
in the application never triggers preparation or a download.

Source: https://github.com/openmultiplayer/omp-stdlib/tree/17c1b0191195cb0b59a820135fbca622c84129dd
