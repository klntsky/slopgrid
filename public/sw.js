/* Build replaces these values with the release's asset inventory and policy. */
const ASSETS = __PWA_ASSETS__;
const SHELL = "/offline-shell.html?release=" + __PWA_VERSION__;
const STATIC = "slopgrid-static-v1";
const POLICY = __PWA_POLICY__;
const STATE = "slopgrid-state-v1";
const PREFIX = "slopgrid-data-v1-";
let scope;
let epoch = 0;
let writes = Promise.resolve();
const pending = new Map();

function serial(work) {
  const result = writes.then(work);
  writes = result.catch(() => {});
  return result;
}
async function currentScope() {
  if (scope === undefined) {
    const saved = await (await caches.open(STATE)).match("/__offline_scope");
    scope = saved ? await saved.text() : "public";
  }
  return scope;
}
async function partition(next, previous, started) {
  return serial(async () => {
    await currentScope();
    if ((previous !== scope || started !== epoch) && next !== scope)
      return false;
    if (next !== scope) {
      epoch++;
      scope = next;
      await Promise.all(
        (await caches.keys())
          .filter((name) => name.startsWith(PREFIX))
          .map((name) => caches.delete(name)),
      );
      await (
        await caches.open(STATE)
      ).put("/__offline_scope", new Response(scope));
    }
    return true;
  });
}
async function clearPrivate() {
  return serial(async () => {
    epoch++;
    scope = "public";
    await Promise.all(
      (await caches.keys())
        .filter((name) => name.startsWith(PREFIX))
        .map((name) => caches.delete(name)),
    );
    await (
      await caches.open(STATE)
    ).put("/__offline_scope", new Response(scope));
  });
}
async function store(url, response, expected) {
  return serial(async () => {
    if (expected !== epoch) return;
    const cache = await caches.open(PREFIX + (await currentScope()));
    // Cache insertion order is the recency index; evict replaceable cached data
    // on quota failure without deleting drafts or the application shell.
    for (;;) {
      try {
        await cache.delete(url);
        await cache.put(url, response.clone());
        return;
      } catch (error) {
        if (error.name !== "QuotaExceededError") return;
        const oldest = (await cache.keys())[0];
        if (!oldest) return;
        await cache.delete(oldest);
      }
    }
  });
}
async function cached(url) {
  await writes;
  const expected = epoch;
  const response = await (
    await caches.open(PREFIX + (await currentScope()))
  ).match(url);
  if (response && expected === epoch) {
    await store(url, response, expected);
    return response;
  }
}
function json(value, headers, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
function cleanGrid(grid) {
  return {
    ...grid,
    live: false,
    cells: grid.cells.map((cell) => {
      const { draft, thinking, previewURL, estimatedUsage, ...saved } = cell;
      return cell.status === "complete"
        ? saved
        : { ...saved, outputURL: undefined, thinkingURL: undefined };
    }),
  };
}
async function saveOutput(url, expected) {
  if (expected !== epoch) return;
  const key = `${epoch}:${url}`;
  if (pending.has(key)) return pending.get(key);
  const work = (async () => {
    const saved = await cached(url);
    if (saved && expected === epoch) {
      if (!url.endsWith("/offline")) return;
      const paths = await saved.json();
      if ((await Promise.all(paths.map((path) => cached(path)))).every(Boolean))
        return;
    }
    const response = await fetch(url);
    if (
      !response.ok ||
      response.headers.get("X-Slopgrid-Output-Ready") !== "1" ||
      expected !== epoch ||
      response.headers.get("X-Slopgrid-Cache-Scope") !== (await currentScope())
    )
      return;
    if (url.endsWith("/offline")) {
      const { pages } = await response.json();
      const id = url.split("/")[2];
      for (const [path, html] of Object.entries(pages)) {
        if (
          !/^[a-zA-Z0-9_./-]+\.html$/.test(path) ||
          path.split("/").includes("..")
        )
          continue;
        await store(
          `/offline/outputs/${id}/${path}`,
          new Response(html, {
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Content-Security-Policy": POLICY,
              "X-Slopgrid-Offline": "1",
              "X-Content-Type-Options": "nosniff",
              "Referrer-Policy": "no-referrer",
            },
          }),
          expected,
        );
      }
      await store(
        url,
        json(
          Object.keys(pages).map((path) => `/offline/outputs/${id}/${path}`),
        ),
        expected,
      );
    } else await store(url, response, expected);
  })()
    .catch(() => {})
    .finally(() => pending.delete(key));
  pending.set(key, work);
  return work;
}
async function saveGridOutputs(grid, expected) {
  for (const cell of grid.cells) {
    if (expected !== epoch) return;
    if (cell.status !== "complete") continue;
    const root = `/outputs/${cell.id}`;
    const urls =
      grid.input.format === "html"
        ? [root + "/offline"]
        : grid.input.format === "markdown"
          ? [root + "?raw=1", root + "?theme=light", root + "?theme=dark"]
          : [root];
    if (cell.thinkingURL) urls.push(cell.thinkingURL);
    urls.push(root + "/download");
    await Promise.all(urls.map((url) => saveOutput(url, expected)));
  }
}
const pagePath = (path) =>
  ["/", "/create", "/grids", "/settings", "/billing", "/index.html"].includes(
    path,
  ) || /^\/grid\/[a-f0-9]{48}$/.test(path);
const apiPath = (path) =>
  [
    "/api/grids",
    "/api/grids/public",
    "/api/session",
    "/api/models",
    "/api/billing",
  ].includes(path) || /^\/api\/(?:grids|references)\/[a-f0-9]{48}$/.test(path);
const outputPath = (path) =>
  /^\/outputs\/[a-f0-9]{48}(?:\/download|\/thinking\/[a-f0-9]{48})?$/.test(
    path,
  );
const offlinePath = (path) => /^\/offline\/outputs\/[a-f0-9]{48}\//.test(path);

async function network(request, event) {
  const url = new URL(request.url);
  const previous = await currentScope();
  const started = epoch;
  let response;
  try {
    response = await fetch(request);
  } catch {
    if (offlinePath(url.pathname))
      return (await cached(request.url)) ?? unavailable(true);
    const saved = await cached(request.url);
    if (saved) {
      if (url.pathname.startsWith("/api/")) {
        const headers = new Headers(saved.headers);
        headers.set("X-Slopgrid-Offline", "1");
        return new Response(saved.body, { status: saved.status, headers });
      }
      return saved;
    }
    if (pagePath(url.pathname))
      return (await (await caches.open(STATIC)).match(SHELL)) ?? unavailable(false);
    return url.pathname.startsWith("/api/")
      ? json(
          { error: "This page isn't available offline." },
          { "X-Slopgrid-Offline": "1" },
          503,
        )
      : unavailable(true);
  }
  const next = response.headers.get("X-Slopgrid-Cache-Scope");
  if (!next || !(await partition(next, previous, started))) return response;
  const expected = epoch;
  if (!response.ok) {
    // An authoritative denial must never fall back to private cached content.
    await serial(async () => {
      if (expected === epoch)
        await (await caches.open(PREFIX + scope)).delete(request.url);
    });
    return response;
  }
  if (/^\/api\/grids\/[a-f0-9]{48}$/.test(url.pathname)) {
    const grid = await response.clone().json();
    await store(
      request.url,
      json(cleanGrid(grid), { "X-Slopgrid-Cache-Scope": next }),
      expected,
    );
    event.waitUntil(saveGridOutputs(grid, expected));
  } else if (
    pagePath(url.pathname) ||
    apiPath(url.pathname) ||
    offlinePath(url.pathname) ||
    response.headers.get("X-Slopgrid-Output-Ready") === "1"
  ) {
    await store(request.url, response, expected);
    if (pagePath(url.pathname)) {
      const html = await response.clone().text();
      const embedded = html.match(
        /<script id="slopgrid-grids">window\.__SLOPGRID_GRIDS__ = ([\s\S]*?);<\/script>/,
      );
      if (embedded) {
        const lists = JSON.parse(embedded[1]);
        for (const [kind, path] of [
          ["owned", "/api/grids"],
          ["public", "/api/grids/public"],
        ]) {
          for (const { key, data } of lists[kind] ?? [])
            await store(`${path}?page=${key}`, json(data), expected);
        }
      }
    }
  }
  return response;
}
function unavailable(output) {
  return new Response(
    `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><title>slopgrid</title><p>This ${output ? "output" : "page"} isn't available offline.</p><button onclick="location.reload()">Retry</button></html>`,
    {
      status: 503,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": POLICY,
        "X-Slopgrid-Offline": "1",
      },
    },
  );
}
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC)
      .then((cache) =>
        cache.addAll(
          ASSETS.map((path) => (path === "/offline-shell.html" ? SHELL : path)),
        ),
      ),
  );
});
self.addEventListener("activate", (event) => {
  // Retain hashed assets referenced by previously cached pages and open tabs.
  // Activation follows the browser lifecycle instead of replacing a live worker.
  event.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== "GET") {
    if (url.pathname === "/api/auth/logout") {
      const work = (async () => {
        await clearPrivate();
        try {
          return await fetch(request);
        } finally {
          await clearPrivate();
        }
      })();
      event.respondWith(work);
      event.waitUntil(work);
    }
    return;
  }
  if (ASSETS.includes(url.pathname) || url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.open(STATIC).then(async (cache) => {
        const saved = await cache.match(request);
        if (saved) return saved;
        const response = await fetch(request);
        if (response.ok)
          try {
            await cache.put(request, response.clone());
          } catch {
            /* Online use does not depend on cache capacity. */
          }
        return response;
      }),
    );
  } else if (
    pagePath(url.pathname) ||
    apiPath(url.pathname) ||
    outputPath(url.pathname) ||
    offlinePath(url.pathname)
  ) {
    const work = network(request, event).catch(async () => {
      try {
        return await fetch(request);
      } catch {
        return url.pathname.startsWith("/api/")
          ? json(
              { error: "This page isn't available offline." },
              { "X-Slopgrid-Offline": "1" },
              503,
            )
          : unavailable(outputPath(url.pathname) || offlinePath(url.pathname));
      }
    });
    event.respondWith(work);
    event.waitUntil(work.then(() => {}));
  }
});
self.addEventListener("message", (event) => {
  if (
    !event.source?.url ||
    new URL(event.source.url).origin !== self.location.origin
  )
    return;
  if (
    event.data?.type === "cache-grid" &&
    /^[a-f0-9]{48}$/.test(event.data.id)
  ) {
    event.waitUntil(
      network(
        new Request(
          new URL(`/api/grids/${event.data.id}`, self.location.origin),
        ),
        event,
      ).catch(() => {}),
    );
  }
});
