import { expect, it, vi } from "vitest";
import { executeCommand, filterCommands, type AppCommand } from "./commands";

it("searches command words and shortcuts while keeping disabled results identifiable", () => {
  const commands: AppCommand[] = [
    {
      label: "command.save",
      enabled: false,
      shortcut: "Ctrl+S",
      run: () => undefined,
    },
    {
      label: "command.saveAll",
      enabled: true,
      shortcut: "Ctrl+Alt+S",
      run: () => undefined,
    },
    { label: "command.settings", enabled: true, run: () => undefined },
  ];
  expect(
    filterCommands(commands, "> ALL save").map((command) => command.label)
  ).toEqual(["command.saveAll"]);
  expect(filterCommands(commands, "ctrl+s")[0].enabled).toBe(false);
  expect(filterCommands(commands, "missing")).toEqual([]);
});

it("does not execute unavailable commands and reports sync and async failures", async () => {
  const report = vi.fn();
  const run = vi.fn();
  executeCommand({ label: "command.save", enabled: false, run }, report);
  expect(run).not.toHaveBeenCalled();
  executeCommand(
    {
      label: "command.save",
      enabled: true,
      run: () => {
        throw new Error("sync");
      },
    },
    report
  );
  executeCommand(
    {
      label: "command.save",
      enabled: true,
      run: async () => {
        throw new Error("async");
      },
    },
    report
  );
  await Promise.resolve();
  expect(report.mock.calls.map(([error]) => error.message)).toEqual([
    "sync",
    "async",
  ]);
});
