import { expect, it } from "vitest";
import { NavigationHistory } from "./navigation";

const location = (uri: string, line = 1, column = 1) => ({ uri, line, column });

it("returns through file and same-file jumps without changing the forward trail", () => {
  const history = new NavigationHistory();
  history.record(location("main", 8, 4), "jump");
  history.record(location("include", 25, 7), "jump");
  history.record(location("include", 60, 3), "jump");
  expect(history.peek(-1)).toEqual(location("include", 25, 7));
  history.move(-1);
  expect(history.peek(-1)).toEqual(location("main", 8, 4));
  history.move(-1);
  expect(history.canGoBack).toBe(false);
  expect(history.peek(1)).toEqual(location("include", 25, 7));
  history.move(1);
  expect(history.peek(1)).toEqual(location("include", 60, 3));
});

it("coalesces typing and nearby movement but branches after a new jump", () => {
  const history = new NavigationHistory();
  history.record(location("main", 5), "jump");
  history.record(location("main", 6, 9), "move");
  history.record(location("main", 7, 4), "edit");
  expect(history.canGoBack).toBe(false);
  history.record(location("main", 50), "move");
  expect(history.peek(-1)).toEqual(location("main", 7, 4));
  history.move(-1);
  history.record(location("main", 7, 5), "edit");
  expect(history.canGoForward).toBe(true);
  history.record(location("other", 3), "jump");
  expect(history.canGoForward).toBe(false);
  expect(history.peek(-1)).toEqual(location("main", 7, 5));
});

it("bounds the trail, removes unavailable locations and clears workspace history", () => {
  const history = new NavigationHistory();
  for (let index = 0; index < 250; index++)
    history.record(location(`file-${index}`), "jump");
  let steps = 0;
  while (history.canGoBack) {
    history.move(-1);
    steps++;
  }
  expect(steps).toBe(199);
  history.replaceUri("file-51", "renamed");
  expect(history.peek(1)?.uri).toBe("renamed");
  history.removeWhere((entry) => entry.uri === "renamed");
  expect(history.peek(1)?.uri).toBe("file-52");
  history.clear();
  expect(history.canGoBack).toBe(false);
  expect(history.canGoForward).toBe(false);
  expect(history.peek(-1)).toBeUndefined();
});
