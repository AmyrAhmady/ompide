import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
// Use the editor's pinned TextMate/Oniguruma engines, not JavaScript approximations.
// Recheck these packaged entry points when upgrading the Monaco API dependencies.
import { __require as requireTextmate } from "@codingame/monaco-vscode-api/external/vscode-textmate/release/main";
import { __require as requireOnig } from "@codingame/monaco-vscode-textmate-service-override/external/vscode-oniguruma/release/main";

const textmate = requireTextmate();
const onig = requireOnig();
const bytes = await readFile(
  new URL(
    "../node_modules/@codingame/monaco-vscode-textmate-service-override/external/vscode-oniguruma/release/onig.wasm",
    import.meta.url
  )
);
await onig.loadWASM(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
);
const raw = JSON.parse(
  await readFile(
    new URL("../src/editor/pawn/pawn.tmLanguage.json", import.meta.url),
    "utf8"
  )
);
const registry = new textmate.Registry({
  onigLib: Promise.resolve(onig),
  loadGrammar: async (scope) => (scope === "source.pawn" ? raw : null),
});
const grammar = await registry.loadGrammar("source.pawn");
after(() => registry.dispose());

function tokenize(source) {
  let state = textmate.INITIAL;
  return source.split(/\r?\n/).map((line) => {
    const result = grammar.tokenizeLine(line, state, 200);
    assert.equal(result.stoppedEarly, false, `Tokenization timed out: ${line}`);
    state = result.ruleStack;
    return { line, tokens: result.tokens };
  });
}

function scopes(rows, row, word) {
  const { line, tokens } = rows[row];
  const start = line.indexOf(word);
  assert.ok(start >= 0, `Missing test word ${word} in ${line}`);
  return (
    tokens.find((token) => token.startIndex <= start && token.endIndex > start)
      ?.scopes ?? []
  );
}

function has(rows, row, word, scope) {
  assert.ok(
    scopes(rows, row, word).includes(scope),
    `${word}: expected ${scope}; got ${scopes(rows, row, word).join(" ")}`
  );
}

test("preserves Pawn declaration, type, function and boolean highlighting", () => {
  const rows = tokenize(
    "public OnReady() {}\nstock Float:Scale(Float:value) { return value; }\nnew const READY = true;"
  );
  has(rows, 0, "public", "storage.modifier.pawn");
  has(rows, 0, "OnReady", "entity.name.function.definition.pawn");
  has(rows, 1, "Float", "entity.name.type.tag.pawn");
  has(rows, 2, "new", "storage.type.pawn");
  has(rows, 2, "const", "storage.modifier.pawn");
  has(rows, 2, "true", "constant.language.pawn");
});

test("highlights format fields while protecting escaped percents and character literals", () => {
  const rows = tokenize(
    String.raw`printf("%d %02d %.2f %s %% \%d ^%s");` + "\nnew ch = '%';"
  );
  for (const field of ["%d", "%02d", "%.2f", "%s", "%%"])
    has(rows, 0, field, "constant.other.placeholder.pawn");
  for (const escaped of ["\\%", "^%"])
    has(rows, 0, escaped, "constant.character.escape.pawn");
  assert.ok(!scopes(rows, 1, "%").includes("constant.other.placeholder.pawn"));
});

test("keeps multiline macro parameters, stringify and paste tokens in the macro context", () => {
  const rows = tokenize(
    [
      "#define APPLY(%0) \\",
      "    Do(%0); \\",
      '    #%0 ## suffix + format("%s", %0)',
      "public After() {}",
    ].join("\n")
  );
  has(rows, 0, "APPLY", "entity.name.function.preprocessor.pawn");
  for (const row of [0, 1, 2])
    has(rows, row, "%0", "variable.parameter.macro.pawn");
  has(rows, 2, "#%0", "keyword.operator.preprocessor.pawn");
  has(rows, 2, "##", "keyword.operator.preprocessor.pawn");
  has(rows, 2, "%s", "constant.other.placeholder.pawn");
  assert.ok(
    !scopes(rows, 3, "public").includes("meta.preprocessor.macro.pawn")
  );
  has(rows, 3, "public", "storage.modifier.pawn");
});

test("continues object macros and distinguishes a space before replacement parentheses", () => {
  const rows = tokenize(
    [
      '#define MESSAGE "first %s" \\',
      '    "next %d"',
      "#define VALUE (123)",
      "new after;",
    ].join("\n")
  );
  has(rows, 0, "MESSAGE", "entity.name.constant.preprocessor.pawn");
  has(rows, 1, "%d", "constant.other.placeholder.pawn");
  has(rows, 1, "next", "meta.preprocessor.macro.pawn");
  has(rows, 2, "VALUE", "entity.name.constant.preprocessor.pawn");
  has(rows, 3, "new", "storage.type.pawn");
});

test("recognizes comment annotations without coloring ordinary strings as comments", () => {
  const rows = tokenize(
    '// TODO: later\n/* FIXME: now\n * NOTE: example */\nnew text[] = "TODO FIXME";'
  );
  has(rows, 0, "TODO", "keyword.other.annotation.todo.pawn");
  has(rows, 1, "FIXME", "keyword.other.annotation.urgent.pawn");
  has(rows, 2, "NOTE", "keyword.other.annotation.note.pawn");
  assert.ok(
    !scopes(rows, 3, "TODO").some((scope) =>
      scope.startsWith("keyword.other.annotation")
    )
  );
});

test("continues line comments only across an explicit backslash continuation", () => {
  const rows = tokenize(
    ["// NOTE: continued " + "\\", "public hidden;", "new visible;"].join("\n")
  );
  has(rows, 1, "public", "comment.line.double-slash.pawn");
  has(rows, 2, "new", "storage.type.pawn");
});

test("recovers after unclosed literals and preserves escaped quotes and line continuations", () => {
  const rows = tokenize(
    [
      'new bad[] = "unfinished',
      "new recovered;",
      'new continued[] = "first\\',
      'second";',
      String.raw`new quoted[] = "escaped \"quote\" and ^"quote^"";`,
      "new after;",
      "new badchar = 'x",
      "new recoveredAgain;",
    ].join("\n")
  );
  has(rows, 1, "new", "storage.type.pawn");
  has(rows, 3, "second", "string.quoted.double.pawn");
  has(rows, 4, '\\"', "constant.character.escape.pawn");
  has(rows, 5, "new", "storage.type.pawn");
  has(rows, 7, "new", "storage.type.pawn");
});

test("handles Pawn numeric separators and switch ranges without consuming range dots as decimals", () => {
  const rows = tokenize(
    "new a = 1_000, b = 0xFF_FF, c = 0b1010_0011;\nnew Float:d = 1_000.25e-2;\ncase 1..10: return;"
  );
  for (const number of ["1_000", "0xFF_FF", "0b1010_0011"])
    assert.ok(
      scopes(rows, 0, number).some((scope) =>
        scope.startsWith("constant.numeric")
      )
    );
  has(rows, 1, "1_000.25e-2", "constant.numeric.float.pawn");
  has(rows, 2, "..", "keyword.operator.switch-range.pawn");
});

test("colors Pawn pragma names, emit opcodes and preprocessor messages", () => {
  const rows = tokenize(
    "#pragma tabsize 4\n#emit LOAD.pri 12\n#error Missing include\n#warning Check configuration"
  );
  has(rows, 0, "tabsize", "keyword.other.pragma.pawn");
  has(rows, 1, "LOAD.pri", "entity.name.function.preprocessor.pawn");
  has(rows, 2, "Missing", "string.unquoted.preprocessor-message.pawn");
  has(rows, 3, "Check", "string.unquoted.preprocessor-message.pawn");
});

test("keeps multi-character assignment, shift, comparison and logical operators intact", () => {
  const rows = tokenize(
    "left <<= 2;\nright = left << 1;\nif (left >= right && left != 0) ++right;"
  );
  has(rows, 0, "<<=", "keyword.operator.assignment.pawn");
  has(rows, 1, "<<", "keyword.operator.bitwise.pawn");
  has(rows, 2, ">=", "keyword.operator.comparison.pawn");
  has(rows, 2, "!=", "keyword.operator.comparison.pawn");
  has(rows, 2, "&&", "keyword.operator.logical.pawn");
  has(rows, 2, "++", "keyword.operator.increment-decrement.pawn");
});

test("has no dangling grammar includes", () => {
  const visit = (value) => {
    if (typeof value !== "object" || value === null) return;
    if (typeof value.include === "string" && value.include.startsWith("#"))
      assert.ok(
        Object.hasOwn(raw.repository, value.include.slice(1)),
        `Missing ${value.include}`
      );
    for (const child of Object.values(value)) visit(child);
  };
  visit(raw);
});
