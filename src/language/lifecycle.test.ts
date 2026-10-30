import { expect, it } from "vitest";
import { DocumentLifecycle } from "./lifecycle";

it("holds changes, requests and close behind an in-flight open, preserving edit order", async () => {
  const lifecycle = new DocumentLifecycle();
  const events: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const open = lifecycle.open("file:///main.pwn", async () => {
    await gate;
    events.push("open");
  });
  const change1 = lifecycle.change(
    "file:///main.pwn",
    async () => undefined,
    async () => {
      events.push("change-1");
    }
  );
  const change2 = lifecycle.change(
    "file:///main.pwn",
    async () => undefined,
    async () => {
      events.push("change-2");
    }
  );
  const request = lifecycle
    .ready("file:///main.pwn")
    .then(() => events.push("request"));
  const close = lifecycle.close("file:///main.pwn", async () => {
    events.push("close");
  });
  await Promise.resolve();
  expect(events).toEqual([]);
  release();
  await Promise.all([open, change1, change2, request, close]);
  expect(events.slice(0, 3)).toEqual(["open", "change-1", "change-2"]);
  expect(events).toContain("request");
  expect(events).toContain("close");
});
it("handles a change that flushes an unopened background document and does not block other files", async () => {
  const lifecycle = new DocumentLifecycle();
  const events: string[] = [];
  await lifecycle.change(
    "file:///background.inc",
    () =>
      lifecycle.open("file:///background.inc", async () => {
        events.push("open");
      }),
    async () => {
      events.push("change");
    }
  );
  await lifecycle.open("file:///other.pwn", async () => {
    events.push("other");
  });
  expect(events).toEqual(["open", "change", "other"]);
});
it("cancels queued changes during disposal without sending stale notifications", async () => {
  const lifecycle = new DocumentLifecycle();
  let sent = false;
  const change = lifecycle.change(
    "file:///main.pwn",
    async () => undefined,
    async () => {
      sent = true;
    }
  );
  lifecycle.dispose();
  await change;
  expect(sent).toBe(false);
});
it("suppresses recursive duplicate opens while letting the original open finish", async () => {
  const lifecycle = new DocumentLifecycle();
  let sent = 0;
  await lifecycle.open("file:///main.pwn", async () => {
    await lifecycle.open("file:///main.pwn", async () => {
      throw new Error("duplicate open");
    });
    sent++;
  });
  await lifecycle.ready("file:///main.pwn");
  expect(sent).toBe(1);
});

it("holds workspace refresh behind initial opens even when no edits are queued", async () => {
  const lifecycle = new DocumentLifecycle();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const opening = lifecycle.open("file:///main.pwn", () => gate);
  let refreshed = false;
  const refresh = lifecycle.changes().then(() => {
    refreshed = true;
  });
  await Promise.resolve();
  expect(refreshed).toBe(false);
  release();
  await Promise.all([opening, refresh]);
  expect(refreshed).toBe(true);
});

it("orders an unedited close behind its open and cancels it when the session retires", async () => {
  for (const retire of [false, true]) {
    const lifecycle = new DocumentLifecycle();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const opening = lifecycle.open("file:///main.pwn", () => gate);
    let sent = false;
    const closing = lifecycle.close("file:///main.pwn", async () => {
      sent = true;
    });
    await Promise.resolve();
    expect(sent).toBe(false);
    if (retire) lifecycle.dispose();
    else release();
    await closing;
    expect(sent).toBe(!retire);
    release();
    await opening;
  }
});
