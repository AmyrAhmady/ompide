import { object, themeJson, ThemeError } from "./theme";
import { packageSizeLimit, unpackThemes } from "./theme-package";

export interface RegistryTheme {
  name: string;
  namespace: string;
  displayName: string;
  version: string;
  download: string;
  checksum: string;
}

function registryUrl(value: unknown): string {
  if (typeof value !== "string") throw new ThemeError("themeRegistry");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "open-vsx.org" ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith("/api/")
  )
    throw new ThemeError("themeRegistry");
  return url.href;
}

async function read(
  url: string,
  maximum: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  try {
    const response = await fetch(registryUrl(url), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok || !response.body) throw new ThemeError("themeRegistry");
    if (
      response.url &&
      !["open-vsx.org", "openvsx.eclipsecontent.org"].includes(
        new URL(response.url).hostname
      )
    )
      throw new ThemeError("themeRegistry");
    if (Number(response.headers.get("content-length")) > maximum)
      throw new ThemeError("themeSize");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maximum) throw new ThemeError("themeSize");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } catch (error) {
    if (error instanceof ThemeError || signal.aborted) throw error;
    throw new ThemeError("themeRegistry");
  }
}

export async function searchThemes(
  query: string,
  signal: AbortSignal
): Promise<RegistryTheme[]> {
  const url = new URL("https://open-vsx.org/api/-/search");
  url.search = new URLSearchParams({
    query: query.slice(0, 256),
    category: "Themes",
    size: "30",
  }).toString();
  const result = themeJson(
    new TextDecoder().decode(await read(url.href, 1024 * 1024, signal))
  );
  if (!object(result) || !Array.isArray(result.extensions))
    throw new ThemeError("themeRegistry");
  return result.extensions
    .filter((item) => object(item) && !item.deprecated)
    .map((item: Record<string, unknown>) => {
      if (
        !object(item.files) ||
        typeof item.name !== "string" ||
        typeof item.namespace !== "string" ||
        typeof item.version !== "string"
      )
        throw new ThemeError("themeRegistry");
      return {
        name: item.name,
        namespace: item.namespace,
        displayName:
          typeof item.displayName === "string" ? item.displayName : item.name,
        version: item.version,
        download: registryUrl(item.files.download),
        checksum: registryUrl(item.files.sha256),
      };
    });
}

export async function downloadThemes(item: RegistryTheme, signal: AbortSignal) {
  const [bytes, digest] = await Promise.all([
    read(item.download, packageSizeLimit, signal),
    read(item.checksum, 4096, signal),
  ]);
  const expected = new TextDecoder()
    .decode(digest)
    .trim()
    .split(/\s/)[0]
    .toLowerCase();
  const actual = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (!/^[\da-f]{64}$/.test(expected) || expected !== actual)
    throw new ThemeError("themeChecksum");
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return unpackThemes(bytes);
}
