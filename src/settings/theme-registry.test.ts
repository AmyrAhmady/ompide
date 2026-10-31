import { afterEach, expect, it, vi } from "vitest";
import { searchThemes, downloadThemes } from "./theme-registry";

afterEach(() => vi.unstubAllGlobals());

it("searches only the theme category and refuses download URLs outside the registry", async () => {
  const mock = vi.fn(async (requestUrl: string) => {
    expect(requestUrl).toContain("open-vsx.org");
    return new Response(
      JSON.stringify({
        extensions: [
          {
            name: "example",
            namespace: "author",
            version: "1.0",
            files: {
              download: "https://evil.test/theme.vsix",
              sha256: "https://open-vsx.org/api/sha256",
            },
          },
        ],
      })
    );
  });
  vi.stubGlobal("fetch", mock);
  await expect(
    searchThemes("dracula", new AbortController().signal)
  ).rejects.toThrow();
  const url = new URL(mock.mock.calls[0][0]);
  expect(url.hostname).toBe("open-vsx.org");
  expect(url.searchParams.get("category")).toBe("Themes");
});

it("reports network failures and rejects corrupt downloads before extracting", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("unavailable", { status: 503 }))
  );
  await expect(
    searchThemes("test", new AbortController().signal)
  ).rejects.toMatchObject({ code: "themeRegistry" });
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async (url: string) =>
        new Response(url.endsWith(".sha256") ? "0".repeat(64) : "bad package")
    )
  );
  await expect(
    downloadThemes(
      {
        name: "x",
        namespace: "x",
        displayName: "x",
        version: "1",
        download: "https://open-vsx.org/api/x.vsix",
        checksum: "https://open-vsx.org/api/x.sha256",
      },
      new AbortController().signal
    )
  ).rejects.toMatchObject({ code: "themeChecksum" });
});
