import type { ProjectInfo } from "./types";

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown) => (typeof value === "string" ? value : "");

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

const join = (root: string, child: string) =>
  /^[a-z]:[/\\]|^[/\\]/i.test(child)
    ? child
    : `${root.replace(/[/\\]+$/, "")}/${child}`;

export function buildConfiguration(info: ProjectInfo, name = "") {
  const configuration = record(info.configuration);
  const defaults = record(configuration.build);
  const named = Array.isArray(configuration.builds)
    ? configuration.builds.map(record)
    : [];
  const selected = name
    ? (named.find((build) => build.name === name) ?? {})
    : configuration.build
      ? defaults
      : (named[0] ?? {});
  const entry = text(selected.input) || text(defaults.input);
  const path = entry ? join(info.project.root, entry) : info.project.entry;
  const includes = [
    ...(text(configuration.include_path)
      ? [text(configuration.include_path)]
      : []),
    ...strings(record(configuration.pawnkit).includePaths),
    ...(strings(selected.includes).length
      ? strings(selected.includes)
      : strings(defaults.includes)),
  ];
  return {
    entry: path,
    includes,
    args: strings(selected.args).length
      ? strings(selected.args)
      : strings(defaults.args),
    builds: named.map((build) => text(build.name)).filter(Boolean),
    output: join(
      info.project.root,
      `output/${
        path
          .split(/[/\\]/)
          .at(-1)
          ?.replace(/\.pwn$/i, "") ?? "main"
      }.amx`
    ),
  };
}
