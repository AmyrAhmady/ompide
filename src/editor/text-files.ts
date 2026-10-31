/** Disk codecs use stable technical names; all buffers and LSP messages are Unicode. */
export interface TextEncoding {
  encoding: string;
  bom: boolean;
}

export const largeFileBytes = 8 * 1024 * 1024;

// Bound UTF-16 model size too, before UTF-8/JSON serialization for language tools.
export const largeFileCharacters = 4 * 1024 * 1024;

export const encodingChoices = [
  { id: "utf-8", label: "UTF-8", encoding: "utf-8", bom: false },
  { id: "utf-8-bom", label: "UTF-8 BOM", encoding: "utf-8", bom: true },
  { id: "utf-16le", label: "UTF-16 LE", encoding: "utf-16le", bom: true },
  { id: "utf-16be", label: "UTF-16 BE", encoding: "utf-16be", bom: true },
  { id: "utf-32le", label: "UTF-32 LE", encoding: "utf-32le", bom: true },
  { id: "utf-32be", label: "UTF-32 BE", encoding: "utf-32be", bom: true },
  ...[
    "windows-1250",
    "windows-1251",
    "windows-1252",
    "windows-1253",
    "windows-1254",
    "windows-1255",
    "windows-1256",
    "windows-1257",
    "windows-1258",
    "windows-874",
    "ibm866",
    "iso-8859-1",
    "iso-8859-2",
    "iso-8859-3",
    "iso-8859-4",
    "iso-8859-5",
    "iso-8859-6",
    "iso-8859-7",
    "iso-8859-8",
    "iso-8859-8-i",
    "iso-8859-10",
    "iso-8859-13",
    "iso-8859-14",
    "iso-8859-15",
    "iso-8859-16",
    "koi8-r",
    "koi8-u",
    "macintosh",
    "x-mac-cyrillic",
    "shift_jis",
    "euc-jp",
    "iso-2022-jp",
    "euc-kr",
    "gbk",
    "gb18030",
    "big5",
    "ascii",
  ].map((encoding) => ({
    id: encoding,
    label: encoding,
    encoding,
    bom: false,
  })),
];

export function encodingLabel(value?: TextEncoding): string {
  if (!value) return "UTF-8";
  const selected =
    encodingChoices.find(
      (choice) => choice.encoding === value.encoding && choice.bom === value.bom
    ) ?? encodingChoices.find((choice) => choice.encoding === value.encoding);
  return selected?.label ?? value.encoding;
}
