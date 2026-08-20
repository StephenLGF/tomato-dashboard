const LEGACY_ISSUE_QUERY_PARAM = "issue";

export function readCardIdentifier(pathname: string, search = ""): string | null {
  const match = pathname.match(/^\/cards\/([^/]+)(?:\/conversations\/[^/]+)?\/?$/u);
  if (match) {
    try {
      return decodeURIComponent(match[1]).trim().toUpperCase() || null;
    } catch {
      return null;
    }
  }
  const legacy = new URLSearchParams(search).get(LEGACY_ISSUE_QUERY_PARAM)?.trim().toUpperCase();
  return legacy || null;
}

export function readConversationIdentifier(pathname: string): string | null {
  const match = pathname.match(/^\/cards\/[^/]+\/conversations\/([^/]+)\/?$/u);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).trim() || null;
  } catch {
    return null;
  }
}

export function buildHomeUrl(href: string): URL {
  const url = new URL(href);
  url.pathname = "/";
  url.searchParams.delete(LEGACY_ISSUE_QUERY_PARAM);
  url.searchParams.delete("next");
  url.searchParams.delete("project");
  return url;
}

export function buildLoginUrl(href: string, next: string | null = null): URL {
  const url = new URL(href);
  url.pathname = "/login";
  url.searchParams.delete(LEGACY_ISSUE_QUERY_PARAM);
  url.searchParams.delete("project");
  if (next && next.startsWith("/") && !next.startsWith("//")) url.searchParams.set("next", next);
  else url.searchParams.delete("next");
  return url;
}

export function buildCardUrl(href: string, cardIdentifier: string): URL {
  const url = buildHomeUrl(href);
  url.pathname = `/cards/${encodeURIComponent(cardIdentifier.trim().toUpperCase())}`;
  return url;
}

export function buildCardConversationUrl(
  href: string,
  cardIdentifier: string,
  conversationIdentifier: string,
): URL {
  const url = buildCardUrl(href, cardIdentifier);
  url.pathname += `/conversations/${encodeURIComponent(conversationIdentifier)}`;
  return url;
}
