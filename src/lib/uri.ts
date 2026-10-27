interface ResourceUri { scheme: string; authority: string; path: string; toString(): string }

/** Canonical file URLs agree with native/PawnKit paths; VS Code otherwise escapes drive colons. */
export function protocolUri(uri: ResourceUri): string {
  if (uri.scheme !== 'file') return uri.toString();
  const url = new URL('file:///');
  url.host = uri.authority;
  url.pathname = uri.path.replaceAll('%', '%25').replace(/^\/([a-zA-Z]):/, (_, drive: string) => `/${drive.toUpperCase()}:`);
  return url.href;
}
