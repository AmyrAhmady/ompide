export interface Layout {
  sidebarWidth: number;
  panelHeight: number;
  sidebarVisible: boolean;
  sidebar: "explorer" | "search" | "sourceControl";
  panelVisible: boolean;
  panel: "problems" | "build" | "terminal";
}

export const defaultLayout: Layout = {
  sidebarWidth: 235,
  panelHeight: 220,
  sidebarVisible: true,
  sidebar: "explorer",
  panelVisible: false,
  panel: "problems",
};

export function parseLayout(value: unknown): Layout {
  const layout = { ...defaultLayout };
  if (typeof value !== "object" || value === null) return layout;
  const source = value as Record<string, unknown>;
  for (const key of ["sidebarWidth", "panelHeight"] as const) {
    const minimum = key === "sidebarWidth" ? 170 : 100;
    const maximum = key === "sidebarWidth" ? 640 : 800;
    if (
      typeof source[key] === "number" &&
      Number.isInteger(source[key]) &&
      source[key] >= minimum &&
      source[key] <= maximum
    )
      layout[key] = source[key];
  }
  for (const key of ["sidebarVisible", "panelVisible"] as const) {
    if (typeof source[key] === "boolean") layout[key] = source[key];
  }
  if (
    source.sidebar === "explorer" ||
    source.sidebar === "search" ||
    source.sidebar === "sourceControl"
  )
    layout.sidebar = source.sidebar;
  if (
    source.panel === "problems" ||
    source.panel === "build" ||
    source.panel === "terminal"
  )
    layout.panel = source.panel;
  return layout;
}

export function paneLimits(vertical: boolean, available: number, fixed = 0) {
  const reserve = vertical ? 284 + fixed : 124 + fixed;
  const minimum = vertical
    ? 170
    : Math.min(100, Math.max(35, Math.floor(available - reserve)));
  const maximum = Math.max(
    minimum,
    Math.min(vertical ? 640 : 800, Math.floor(available - reserve))
  );
  return { minimum, maximum };
}

export function clampPane(
  value: number,
  minimum: number,
  maximum: number
): number {
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}
