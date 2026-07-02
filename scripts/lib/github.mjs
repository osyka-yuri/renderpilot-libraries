export const USER_AGENT = "renderpilot-libraries";
export const SNAPSHOT_API =
  "https://api.github.com/repos/clshortfuse/renodx/releases/tags/snapshot";

export class SnapshotUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SnapshotUnavailableError";
  }
}

export function githubHeaders() {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  return headers;
}

export async function fetchJson(url) {
  let res;

  try {
    res = await fetch(url, { headers: githubHeaders() });
  } catch (err) {
    throw new SnapshotUnavailableError(`request failed: ${err.message}`, {
      cause: err,
    });
  }

  if (!res.ok) {
    throw new SnapshotUnavailableError(
      `GitHub API returned ${res.status} ${res.statusText} for ${url}`,
    );
  }

  try {
    return {
      data: await res.json(),
      headers: res.headers,
    };
  } catch (err) {
    throw new SnapshotUnavailableError(`GitHub API returned invalid JSON: ${err.message}`, {
      cause: err,
    });
  }
}

export function getNextUrlFromLinkHeader(header) {
  if (!header) return null;

  // Split multiple links like: <url1>; rel="next", <url2>; rel="last"
  const links = header.split(",");

  for (const link of links) {
    const parts = link.split(";");
    if (parts.length < 2) continue;

    const urlPart = parts[0].trim();
    const relPart = parts[1].trim();

    if (
      urlPart.startsWith("<") &&
      urlPart.endsWith(">") &&
      relPart.includes('rel="next"')
    ) {
      return urlPart.slice(1, -1);
    }
  }

  return null;
}

export async function fetchAllPaginatedItems(initialUrl) {
  let allItems = [];
  let nextUrl = initialUrl;

  while (nextUrl) {
    const { data, headers } = await fetchJson(nextUrl);

    if (Array.isArray(data)) {
      allItems = allItems.concat(data);
    } else {
      throw new SnapshotUnavailableError("Expected array response for paginated items");
    }

    nextUrl = getNextUrlFromLinkHeader(headers.get("link"));
  }

  return allItems;
}

export async function fetchSnapshotRelease() {
  const { data: release } = await fetchJson(SNAPSHOT_API);

  if (release.assets_url) {
    release.assets = await fetchAllPaginatedItems(`${release.assets_url}?per_page=100`);
  }

  return release;
}
