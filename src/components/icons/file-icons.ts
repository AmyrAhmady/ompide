import seti from "./seti/icon-theme.json";

interface Associations {
  file: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  languageIds: Record<string, string>;
}

// Seti delegates common extensions to VS Code's language registry. ompide does
// not register editors for all of those languages; retain their icon metadata
// separately without changing a document's actual editor/LSP language.
const extensionLanguages: Record<string, string> = {
  json: "json",
  jsonc: "jsonc",
  jsonl: "jsonl",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascriptreact",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "typescriptreact",
  md: "markdown",
  markdown: "markdown",
  rs: "rust",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  css: "css",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  yaml: "yaml",
  yml: "yaml",
  py: "python",
  go: "go",
  java: "java",
  lua: "lua",
  php: "php",
  rb: "ruby",
  sh: "shellscript",
  bash: "shellscript",
  ps1: "powershell",
  psm1: "powershell",
  bat: "bat",
  cmd: "bat",
  sql: "sql",
  vue: "vue",
  scss: "scss",
  sass: "sass",
  less: "less",
  dart: "dart",
  swift: "swift",
  kt: "kotlin",
  r: "r",
  gitignore: "ignore",
  gitattributes: "ignore",
  env: "dotenv",
};
const filenameLanguages: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  ".gitmodules": "ignore",
};

const definitions: Record<
  string,
  { fontCharacter: string; fontColor?: string }
> = seti.iconDefinitions;

function normalized(entries: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(entries).map(([name, icon]) => [name.toLowerCase(), icon])
  );
}

const dark: Associations = {
  file: seti.file,
  fileNames: normalized(seti.fileNames),
  fileExtensions: normalized(seti.fileExtensions),
  languageIds: seti.languageIds,
};
const light: Associations = {
  file: seti.light.file,
  fileNames: { ...dark.fileNames, ...normalized(seti.light.fileNames) },
  fileExtensions: {
    ...dark.fileExtensions,
    ...normalized(seti.light.fileExtensions),
  },
  languageIds: { ...dark.languageIds, ...seti.light.languageIds },
};

function resolve(name: string, associations: Associations) {
  const basename = name.split(/[\\/]/).at(-1)!.toLowerCase();
  let id = associations.fileNames[basename];
  // Match compound suffixes before shorter extensions: test.js before js.
  for (
    let dot = basename.indexOf(".");
    !id && dot >= 0;
    dot = basename.indexOf(".", dot + 1)
  ) {
    id = associations.fileExtensions[basename.slice(dot + 1)];
  }
  const language =
    filenameLanguages[basename] ??
    extensionLanguages[basename.split(".").at(-1)!];
  if (!id && language) id = associations.languageIds[language];
  id ??= associations.file;
  const definition = definitions[id] ?? definitions[associations.file];
  return {
    id,
    character: String.fromCodePoint(
      Number.parseInt(definition.fontCharacter.slice(1), 16)
    ),
    // Neutral document icons follow the row foreground, including selections
    // and custom/high-contrast themes, rather than Seti's pale default grey.
    color:
      id === associations.file
        ? "currentColor"
        : (definition.fontColor ?? "currentColor"),
  };
}

export function fileIcons(name: string) {
  return { dark: resolve(name, dark), light: resolve(name, light) };
}
