import { applyEdits, modify } from "jsonc-parser";
import { parseDocument } from "yaml";

export const compilerOptions = [
  { id: "debug", flag: "-d", choices: ["0", "1", "2", "3"] },
  { id: "optimization", flag: "-O", choices: ["0", "1", "2"] },
  { id: "verbosity", flag: "-v", choices: ["0", "1", "2"] },
  { id: "semicolons", flag: "-;", choices: ["+", "-"] },
  { id: "parentheses", flag: "-(", choices: ["+", "-"] },
  { id: "warningsAsErrors", flag: "-E", choices: ["+", "-", "toggle"] },
  { id: "compatibility", flag: "-Z", choices: ["+", "-"] },
  { id: "compact", flag: "-C", choices: ["+", "-"] },
  { id: "recursion", flag: "-R", choices: ["+", "-"] },
  { id: "escape", flag: "-", choices: ["\\", "^"] },
  { id: "stack", flag: "-S", pattern: /^\d+$/ },
  { id: "tabSize", flag: "-t", pattern: /^\d+$/ },
  { id: "codepage", flag: "-c", pattern: /^[a-z0-9_-]+$/i },
  { id: "alignment", flag: "-A", pattern: /^\d+$/ },
  { id: "memory", flag: "-X", pattern: /^\d+$/ },
  { id: "dataMemory", flag: "-XD", pattern: /^\d+$/ },
  { id: "skipLines", flag: "-s", pattern: /^\d+$/ },
  { id: "warnings", flag: "-w", pattern: /^\d+(?:\s*,\s*\d+)*$/ },
] as const;

export type CompilerOption = (typeof compilerOptions)[number];

export type CompilerValues = Partial<Record<CompilerOption["id"], string>>;

export function validCompilerValue(
  option: CompilerOption,
  value: string
): boolean {
  if (!value || !("pattern" in option)) return true;
  if (!option.pattern.test(value)) return false;
  if (option.id === "codepage") return true;
  const numbers = value.split(",").map(Number);
  if (numbers.some((number) => number > 2147483647)) return false;
  const number = numbers[0];
  if (option.id === "stack") return number > 32;
  if (option.id === "tabSize") return number > 0;
  if (option.id === "alignment") return number > 0 && number % 4 === 0;
  return true;
}

function optionValue(
  option: CompilerOption,
  argument: string
): string | undefined {
  if (!argument.startsWith(option.flag)) return undefined;
  const value = argument.slice(option.flag.length);
  if ("choices" in option) {
    if (option.choices.some((choice) => choice === value)) return value;
    if (!value && option.id === "warningsAsErrors") return "toggle";
    if (!value && option.choices[0] === "+" && option.id !== "warningsAsErrors")
      return "+";
    return undefined;
  }
  return /^\d+$/.test(value) && option.id === "warnings"
    ? value
    : option.id !== "warnings" && option.pattern.test(value)
      ? value
      : undefined;
}

export function compilerValues(args: string[]): CompilerValues {
  const values: CompilerValues = {};
  for (const option of compilerOptions) {
    const matches = args.flatMap((arg) => {
      const value = optionValue(option, arg);
      return value === undefined ? [] : [value];
    });
    values[option.id] =
      option.id === "warnings" ? matches.join(", ") : (matches.at(-1) ?? "");
  }
  return values;
}

export function updateCompilerArgs(
  args: string[],
  values: CompilerValues
): string[] {
  let result = [...args];
  const original = compilerValues(args);
  for (const option of compilerOptions) {
    const value = values[option.id]?.trim();
    if (value === undefined || value === original[option.id]) continue;
    const remaining: string[] = [];
    let position: number | undefined;
    for (const arg of result) {
      if (optionValue(option, arg) === undefined) remaining.push(arg);
      else position = remaining.length;
    }
    result = remaining;
    if (!value) continue;
    const parts =
      option.id === "warnings"
        ? [...new Set(value.split(/\s*,\s*/))]
        : [value === "toggle" ? "" : value];
    result.splice(
      position ?? result.length,
      0,
      ...parts.map((part) => option.flag + part)
    );
  }
  return result;
}

export function editCompilerManifest(
  path: string,
  text: string,
  field: (string | number)[],
  args: string[]
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const value = field.length === 1 ? { args } : args;
  if (/\.ya?ml$/i.test(path)) {
    const document = parseDocument(text);
    if (document.errors.length) throw document.errors[0];
    document.setIn(field, value);
    return document.toString({ lineWidth: 0 }).replaceAll("\n", eol);
  }
  const indent = text.match(/^(\t+| +)"/m)?.[1] ?? "  ";
  return applyEdits(
    text,
    modify(text, field, value, {
      formattingOptions: {
        insertSpaces: indent[0] !== "\t",
        tabSize: indent.length,
        eol,
      },
    })
  );
}
