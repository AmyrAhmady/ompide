import { expect, it } from "vitest";
import { defaults, parseSettings } from "./settings";

it("loads supported persisted preferences without accepting malformed values", () => {
  expect(parseSettings(null)).toEqual(defaults);
  expect(
    parseSettings({
      theme: "unknown",
      fontSize: 999,
      tabSize: 1.5,
      fontFamily: "x".repeat(257),
      minimap: "yes",
    })
  ).toEqual(defaults);
  expect(
    parseSettings({
      theme: "light",
      fontSize: 18,
      tabSize: 2,
      fontFamily: "Consolas",
      insertSpaces: false,
      minimap: true,
      wordWrap: true,
    })
  ).toEqual({
    ...defaults,
    theme: "light",
    fontSize: 18,
    tabSize: 2,
    fontFamily: "Consolas",
    insertSpaces: false,
    minimap: true,
    wordWrap: true,
  });
});
