import { expect, it } from "vitest";
import { clampPane, defaultLayout, paneLimits, parseLayout } from "./layout";

it("loads valid layout preferences without accepting malformed sizes or view identities", () => {
  expect(parseLayout(null)).toEqual(defaultLayout);
  expect(parseLayout({ sidebar: "sourceControl" }).sidebar).toBe(
    "sourceControl"
  );
  expect(
    parseLayout({
      sidebarWidth: Infinity,
      panelHeight: -1,
      sidebarVisible: "yes",
      panel: "terminal",
      sidebar: "invalid",
    })
  ).toEqual(defaultLayout);
  expect(
    parseLayout({
      sidebarWidth: 400,
      panelHeight: 330,
      sidebarVisible: false,
      panelVisible: true,
      panel: "build",
      sidebar: "search",
    })
  ).toEqual({
    sidebarWidth: 400,
    panelHeight: 330,
    sidebarVisible: false,
    panelVisible: true,
    panel: "build",
    sidebar: "search",
  });
});

it("keeps split limits usable on wide and scaled viewports and rounds pixel values", () => {
  expect(paneLimits(true, 521)).toEqual({ minimum: 170, maximum: 237 });
  expect(paneLimits(true, 1920).maximum).toBe(640);
  expect(paneLimits(true, 521, 46)).toEqual({ minimum: 170, maximum: 191 });
  expect(paneLimits(false, 338, 35)).toEqual({ minimum: 100, maximum: 179 });
  expect(paneLimits(false, 150, 35)).toEqual({ minimum: 35, maximum: 35 });
  expect(paneLimits(false, 338, 150)).toEqual({ minimum: 64, maximum: 64 });
  expect(clampPane(500, 170, 237)).toBe(237);
  expect(clampPane(99, 170, 237)).toBe(170);
  expect(clampPane(180.6, 170, 237)).toBe(181);
});
