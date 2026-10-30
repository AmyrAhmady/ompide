// Static coverage complements the translator's runtime fallback/interpolation tests.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));
const english = JSON.parse(
  await readFile(path.join(root, "src/locales/en.json"), "utf8")
);
const failures = [];
const codes = new Set();
// Product/key/encoding identifiers and the case-match icon remain unchanged by locale.
const identifiers = new Set([
  "Ctrl+O",
  "Ctrl+K Ctrl+O",
  "F2",
  "Delete",
  "UTF-8",
  "open.mp",
  "SA-MP",
  "Aa",
]);
const copyAttributes = new Set(["aria-label", "title", "placeholder", "alt"]);

async function files(directory, extension) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(name, extension)));
    else if (extension.test(name)) result.push(name);
  }
  return result;
}

function checkKey(key, file) {
  if (!Object.hasOwn(english, key))
    failures.push(path.relative(root, file) + ": missing English key " + key);
}

for (const file of await files(path.join(root, "src"), /(?<!\.test)\.tsx?$/)) {
  const text = await readFile(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  function visit(node) {
    let copy;
    if (ts.isJsxText(node)) copy = node.text.trim();
    if (
      ts.isJsxExpression(node) &&
      (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent)) &&
      node.expression &&
      ts.isStringLiteral(node.expression)
    )
      copy = node.expression.text;
    if (
      ts.isJsxAttribute(node) &&
      copyAttributes.has(node.name.getText(source))
    ) {
      const value = node.initializer;
      if (value && ts.isStringLiteral(value)) copy = value.text;
      else if (
        value &&
        ts.isJsxExpression(value) &&
        value.expression &&
        ts.isStringLiteral(value.expression)
      )
        copy = value.expression.text;
    }
    if (copy && /[A-Za-z]/.test(copy) && !identifiers.has(copy)) {
      const line =
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      failures.push(
        path.relative(root, file) +
          ":" +
          line +
          ": move UI text into English JSON: " +
          copy
      );
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "t" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      checkKey(node.arguments[0].text, file);
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const match of text.matchAll(
    /(?:code:\s*|new ThemeError\()"([a-zA-Z]+)"/g
  ))
    codes.add(match[1]);
}

for (const file of await files(path.join(root, "src-tauri/src"), /\.rs$/)) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/\berror\(\s*"([a-zA-Z]+)"/g))
    codes.add(match[1]);
  const ioMapping = text.match(
    /code: match error\.kind\(\) \{([\s\S]*?)\}/
  )?.[1];
  if (ioMapping)
    for (const match of ioMapping.matchAll(/=> "([a-zA-Z]+)"/g))
      codes.add(match[1]);
}
for (const code of codes)
  checkKey("error." + code, path.join(root, "src/locales/en.json"));
for (const [key, value] of Object.entries(english)) {
  if (
    !(typeof value === "string" && value.trim()) &&
    !(
      typeof value?.one === "string" &&
      value.one.trim() &&
      typeof value?.other === "string" &&
      value.other.trim()
    )
  )
    failures.push("Malformed English resource: " + key);
}
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else
  console.log(
    "Localization audit passed: JSX copy/labels, literal translation keys, " +
      codes.size +
      " frontend/native error codes and English resource shapes."
  );
