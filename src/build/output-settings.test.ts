import { expect, it } from "vitest";
import { parse } from "yaml";
import { editManifestValue } from "./compilerSettings";

it("saves and resets entry output in JSON and YAML without losing unrelated settings", () => {
  for (const [path, source] of [
    [
      "pawn.json",
      '{\n  "entry": "main.pwn",\n  "build": {"args": ["-d3"]}\n}\n',
    ],
    ["pawn.yaml", "# project\nentry: main.pwn\nbuild:\n  args: [-d3]\n"],
  ]) {
    const read = (text: string) =>
      path.endsWith("json") ? JSON.parse(text) : parse(text);
    const saved = editManifestValue(path, source, ["output"], "bin/main.amx");
    expect(read(saved)).toEqual({
      entry: "main.pwn",
      build: { args: ["-d3"] },
      output: "bin/main.amx",
    });
    const reset = editManifestValue(path, saved, ["output"], undefined);
    expect(read(reset)).toEqual({
      entry: "main.pwn",
      build: { args: ["-d3"] },
    });
    if (path.endsWith("yaml")) expect(reset).toContain("# project");
  }
});
