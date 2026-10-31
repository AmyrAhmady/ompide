# ompide artwork

`ompide.png` is the transparent master for the purple pawn emblem. Keep the
entire emblem and its transparent margin when preparing another size.

Regenerate the desktop icons and web images from the repository root:

```sh
npm run icons:generate
```

The command uses the project's installed Tauri CLI and updates:

- `src-tauri/icons/`: Windows ICO, macOS ICNS, desktop PNGs and Windows logo sizes.
- `public/branding/`: square PNGs at 16, 24, 32, 48, 64, 128, 256, 512 and 1024 pixels.
- `public/favicon.ico`: the browser icon, using the same multi-size ICO.

The application uses these assets in the title bar, welcome screen and Credits
dialog. Platform icon files are prepared assets; they do not imply that builds
for every platform have been tested.
