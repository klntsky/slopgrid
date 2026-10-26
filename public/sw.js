/* Build replaces these values with the release's asset inventory and policy. */
const ASSETS = __PWA_ASSETS__;
const SHELL = "/offline-shell.html?release=" + __PWA_VERSION__;
const STATIC = "slopgrid-static-v1";
const POLICY = __PWA_POLICY__;
const STATE = "slopgrid-state-v1";
const PREFIX = "slopgrid-data-v2-";
let scope;
let epoch = 0;
let writes = Promise.resolve();
const pending = new Map();
const gridReaders = new Map();
const cancelledGridReads = new Map();
let gridReaderWatch;

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
const outputAvailable = (cell) =>
  cell.outputReady || cell.status === "complete";
function cleanGrid(grid) {
  return {
    ...grid,
    live: false,
    cells: grid.cells.map((cell) => {
      const { draft, thinking, previewURL, estimatedUsage, ...saved } = cell;
      return outputAvailable(cell)
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
async function reference(request, event) {
  const key = `reference:${epoch}:${request.url}`;
  let work = pending.get(key);
  if (!work) {
    work = network(request, event).finally(() => pending.delete(key));
    pending.set(key, work);
  }
  return (await work).clone();
}
function releaseGridFlight(flight) {
  if (
    flight.bodySettled ||
    flight.persistent ||
    flight.background ||
    flight.readers.size
  )
    return;
  if (pending.get(flight.key) === flight) pending.delete(flight.key);
  flight.controller.abort();
}
function watchGridReaders() {
  if (!gridReaders.size) {
    clearInterval(gridReaderWatch);
    gridReaderWatch = undefined;
  } else if (gridReaderWatch === undefined) {
    gridReaderWatch = setInterval(async () => {
      const readers = [...gridReaders];
      const clients = new Map();
      for (const [, reader] of readers)
        if (!clients.has(reader.clientId))
          clients.set(reader.clientId, self.clients.get(reader.clientId));
      for (const [key, reader] of readers) {
        if (
          !(await clients.get(reader.clientId)) &&
          gridReaders.get(key) === reader
        )
          cancelGridReader(key, reader);
      }
    }, 5000);
  }
}
function finishGridFlight(flight) {
  flight.bodySettled = true;
  for (const key of flight.readers) {
    const reader = gridReaders.get(key);
    if (reader?.flight !== flight) continue;
    gridReaders.delete(key);
    reader.flight = undefined;
  }
  flight.readers.clear();
  watchGridReaders();
}
function cancelGridReader(key, reader) {
  gridReaders.delete(key);
  reader.cancelled = true;
  const flight = reader.flight;
  reader.flight = undefined;
  flight.readers.delete(key);
  releaseGridFlight(flight);
  watchGridReaders();
}
async function gridRequest(request, event, background = false) {
  const key = `grid:${epoch}:${request.url}`;
  const id = request.headers.get("X-Slopgrid-Grid-Read");
  const readerKey = id && !background ? `${event.clientId}:${id}` : undefined;
  if (readerKey && cancelledGridReads.delete(readerKey))
    return Response.error();
  const reader = readerKey
    ? { clientId: event.clientId, cancelled: false, flight: undefined }
    : undefined;
  if (reader) gridReaders.set(readerKey, reader);
  let flight = pending.get(key);
  if (!flight) {
    const controller = new AbortController();
    const headers = new Headers(request.headers);
    headers.delete("X-Slopgrid-Grid-Read");
    flight = {
      key,
      controller,
      readers: new Set(),
      background: 0,
      persistent: false,
      bodySettled: false,
      work: undefined,
    };
    pending.set(key, flight);
    flight.work = network(
      new Request(request, { headers, signal: controller.signal }),
      event,
      flight,
    )
      .then((response) => {
        if (flight.bodySettled || !response.body) {
          finishGridFlight(flight);
          return response;
        }
        const body = response.body.getReader();
        return new Response(
          new ReadableStream({
            async pull(controller) {
              try {
                const { done, value } = await body.read();
                if (done) {
                  finishGridFlight(flight);
                  controller.close();
                } else controller.enqueue(value);
              } catch (error) {
                finishGridFlight(flight);
                controller.error(error);
              }
            },
            cancel(reason) {
              finishGridFlight(flight);
              return body.cancel(reason);
            },
          }),
          {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          },
        );
      })
      .finally(() => {
        if (pending.get(key) === flight) pending.delete(key);
        flight.work = undefined;
        if (flight.bodySettled || controller.signal.aborted)
          finishGridFlight(flight);
      });
  }
  if (background) flight.background++;
  else if (reader) {
    flight.readers.add(readerKey);
    reader.flight = flight;
  } else flight.persistent = true;
  watchGridReaders();
  try {
    const response = await flight.work;
    return reader?.cancelled ? Response.error() : response.clone();
  } catch (error) {
    if (flight.controller.signal.aborted) return Response.error();
    throw error;
  } finally {
    if (background) {
      flight.background--;
      releaseGridFlight(flight);
    }
  }
}
async function saveReference(id, expected) {
  if (!/^[a-f0-9]{48}$/.test(id) || expected !== epoch) return;
  const request = new Request(
    new URL(`/api/references/${id}`, self.location.origin),
  );
  if (await cached(request.url)) return;
  if (expected === epoch) await reference(request);
}
async function saveGridOutputs(grid, expected) {
  if (grid.cells.some(outputAvailable)) {
    const input = grid.input;
    const messages = [
      ...(input.parameters.input.kind === "common"
        ? input.parameters.input.value
        : input[input.parameters.input.kind].flatMap(
            (record) => record.input ?? [],
          )),
      ...grid.cells
        .filter(outputAvailable)
        .flatMap((cell) => cell.messages ?? []),
    ];
    const configuredImages = [
      ...[...input.rows, ...input.columns].flatMap((record) =>
        (record.variable ?? []).flatMap((field) => field?.images ?? []),
      ),
    ];
    const ids = new Set([
      ...configuredImages.map((image) => image.id),
      ...messages
        .filter((message) => message.role === "user")
        .flatMap((message) => (message.images ?? []).map((image) => image.id)),
    ]);
    await Promise.all([...ids].map((id) => saveReference(id, expected)));
  }
  for (const cell of grid.cells) {
    if (expected !== epoch) return;
    if (!outputAvailable(cell)) continue;
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
async function cacheCompletedGrid(id, completed, event) {
  const request = new Request(
    new URL(`/api/grids/${id}`, self.location.origin),
  );
  const expected = epoch;
  const flight = pending.get(`grid:${expected}:${request.url}`);
  if (flight) {
    flight.background++;
    try {
      await flight.work;
    } finally {
      flight.background--;
      releaseGridFlight(flight);
    }
  }
  await writes;
  if (expected !== epoch) return;
  const saved = await cached(request.url);
  if (expected !== epoch) return;
  if (saved) {
    const grid = await saved.json();
    if (expected !== epoch) return;
    const covered = completed.every((completion) =>
      grid.cells.some(
        (cell) =>
          outputAvailable(cell) &&
          cell.id === completion.id &&
          cell.generationId === completion.generationId &&
          (!completion.judgment ||
            (cell.judge?.status === completion.judgment.status &&
              cell.judge?.attemptId === completion.judgment.attemptId)),
      ),
    );
    if (covered) {
      await saveGridOutputs(grid, expected);
      return;
    }
  }
  if (expected === epoch) await gridRequest(request, event, true);
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
const referencePath = (path) => /^\/api\/references\/[a-f0-9]{48}$/.test(path);
const gridPath = (path) => /^\/api\/grids\/[a-f0-9]{48}$/.test(path);
const staleGrid = () =>
  json(
    { error: "This page isn't available offline." },
    { "X-Slopgrid-Offline": "1" },
    503,
  );
const outputPath = (path) =>
  /^\/outputs\/[a-f0-9]{48}(?:\/download|\/thinking\/[a-f0-9]{48})?$/.test(
    path,
  );
const offlinePath = (path) => /^\/offline\/outputs\/[a-f0-9]{48}\//.test(path);

async function network(request, event, gridFlight) {
  const url = new URL(request.url);
  const previous = await currentScope();
  const started = epoch;
  const image = referencePath(url.pathname);
  const grid = gridPath(url.pathname);
  const savedImage = image ? await cached(request.url) : undefined;
  let response;
  try {
    if (image) {
      const headers = new Headers(request.headers);
      if (savedImage?.headers.has("ETag"))
        headers.set("If-None-Match", savedImage.headers.get("ETag"));
      // CacheStorage owns offline bytes. Never accept an unscoped fresh HTTP
      // cache hit: even immutable images must observe authorization and scope.
      // Native image requests are no-cors, which strips conditional headers.
      // This handler only accepts same-origin URLs.
      response = await fetch(
        new Request(request, {
          headers,
          cache: "no-store",
          mode: "same-origin",
        }),
      );
    } else response = await fetch(request);
  } catch (error) {
    if (request.signal.aborted) throw error;
    if (offlinePath(url.pathname))
      return (await cached(request.url)) ?? unavailable(true);
    const saved = await cached(request.url);
    if ((image || grid) && started !== epoch)
      return grid ? staleGrid() : unavailable(true);
    if (saved) {
      if (url.pathname.startsWith("/api/")) {
        const headers = new Headers(saved.headers);
        headers.set("X-Slopgrid-Offline", "1");
        return new Response(saved.body, { status: saved.status, headers });
      }
      return saved;
    }
    if (pagePath(url.pathname))
      return (
        (await (await caches.open(STATIC)).match(SHELL)) ?? unavailable(false)
      );
    return url.pathname.startsWith("/api/")
      ? json(
          { error: "This page isn't available offline." },
          { "X-Slopgrid-Offline": "1" },
          503,
        )
      : unavailable(true);
  }
  const next = response.headers.get("X-Slopgrid-Cache-Scope");
  if (image && !next && [403, 404].includes(response.status)) {
    await serial(async () => {
      if (started === epoch)
        await (await caches.open(PREFIX + scope)).delete(request.url);
    });
    return response;
  }
  if (image && response.status === 304) {
    if (next) await partition(next, previous, started);
    if (
      !savedImage ||
      started !== epoch ||
      previous !== (await currentScope()) ||
      next !== previous ||
      response.headers.get("ETag") !== savedImage.headers.get("ETag")
    )
      return unavailable(true);
    await store(request.url, savedImage, started);
    return started === epoch ? savedImage : unavailable(true);
  }
  if (grid && started !== epoch && previous === next) return staleGrid();
  if (!next || !(await partition(next, previous, started)))
    return grid && next ? staleGrid() : response;
  const expected = epoch;
  if (!response.ok) {
    // An authoritative denial must never fall back to private cached content.
    await serial(async () => {
      if (expected === epoch)
        await (await caches.open(PREFIX + scope)).delete(request.url);
    });
    return response;
  }
  if (grid) {
    const grid = await response.clone().json();
    if (gridFlight) gridFlight.bodySettled = true;
    await store(
      request.url,
      json(cleanGrid(grid), { "X-Slopgrid-Cache-Scope": next }),
      expected,
    );
    event.waitUntil(saveGridOutputs(grid, expected));
    if (expected !== epoch || next !== (await currentScope()))
      return staleGrid();
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
  event.waitUntil(
    caches.keys().then(async (names) => {
      await Promise.all(
        names
          .filter((name) => name.startsWith("slopgrid-data-v1-"))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    }),
  );
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
    const work = (
      referencePath(url.pathname)
        ? reference(request, event)
        : gridPath(url.pathname)
          ? gridRequest(request, event)
          : network(request, event)
    ).catch(async (error) => {
      if (gridPath(url.pathname) && error?.name === "AbortError")
        return Response.error();
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
    event.data?.type === "cancel-grid-read" &&
    typeof event.data.id === "string" &&
    event.data.id.length <= 128
  ) {
    const key = `${event.source.id}:${event.data.id}`;
    const reader = gridReaders.get(key);
    if (reader) {
      cancelGridReader(key, reader);
    } else {
      cancelledGridReads.set(key, true);
      if (cancelledGridReads.size > 256)
        cancelledGridReads.delete(cancelledGridReads.keys().next().value);
    }
    return;
  }
  if (
    event.data?.type === "cache-grid" &&
    /^[a-f0-9]{48}$/.test(event.data.id) &&
    Array.isArray(event.data.completed) &&
    event.data.completed.every(
      (cell) =>
        cell &&
        /^[a-f0-9]{48}$/.test(cell.id) &&
        /^[a-f0-9]{48}$/.test(cell.generationId) &&
        (cell.judgment === undefined ||
          (cell.judgment &&
            ["complete", "error"].includes(cell.judgment.status) &&
            (cell.judgment.attemptId === undefined ||
              /^[a-f0-9]{48}$/.test(cell.judgment.attemptId)))),
    )
  ) {
    event.waitUntil(
      cacheCompletedGrid(event.data.id, event.data.completed, event).catch(
        () => {},
      ),
    );
  }
});
