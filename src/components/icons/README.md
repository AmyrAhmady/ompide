# Workbench icons

File icons use VS Code's Seti file-icon theme, derived from Jesse Weed's Seti UI.
The unmodified font and associations are pinned in `seti/provenance.json`.
Filename overrides take precedence over compound extensions, then the default
file icon. Dark and light palettes come from the supplied theme data.
VS Code normally supplies common extensions through its language registry.
`file-icons.ts` supplies that metadata for common languages without registering
language services or changing how ompide edits these files.

Source: https://github.com/microsoft/vscode/tree/6f269fc1b4cd8c8bb21902842cc7567a5c67ec00/extensions/theme-seti

Seti UI is copyright (c) 2014 Jesse Weed, MIT licensed. Microsoft contributions
are MIT licensed. Notices are in `packaging/licenses/seti.txt` and
`packaging/licenses/vscode.txt`, copied into release license resources.

UI controls use unmodified SVG assets from `@vscode/codicons`, by Microsoft and
contributors, under Creative Commons Attribution 4.0 International. Source:
https://github.com/microsoft/vscode-codicons
License: https://creativecommons.org/licenses/by/4.0/
Code in that package is MIT licensed. Both license files are collected by the
release notice builder. SVGs are used as CSS masks in `Icon.tsx`, inheriting the
control's foreground; no extension code or global Codicon styles are registered.
