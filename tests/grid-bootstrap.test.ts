import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appFixture } from "./app-fixture.js";
import { seedGridLists } from "./grid-list-fixture.js";
import { createFrontendRoutes } from "../server/frontend.js";
import {
  createGridBootstrap,
  type GridListsBootstrap,
} from "../server/grid-bootstrap.js";

test("HTML embeds three session-filtered pages with safe scripts and per-response CSP hashes", async (t) => {
  const { app, origin, store, session } = await appFixture(t);
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-grid-bootstrap-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(
    join(directory, "index.html"),
    '<html><head></head><body><div id="root"></div></body></html>',
  );
  const owner = "a".repeat(48);
  store.saveSession({ id: owner, created: Date.now() });
  const { owned, publicIds } = seedGridLists(store, owner, {
    owned: 83,
    public: 83,
  });
  const title = "</script><script>window.bad=1</script>";
  store.setTitle(owned[0], title);
  app.use((_req, res, next) => {
    res.set("Content-Security-Policy", "script-src 'self'");
    next();
  });
  app.use(
    await createFrontendRoutes(
      directory,
      undefined,
      createGridBootstrap(store, session),
    ),
  );
  async function read(path: string, cookie?: string) {
    const response = await fetch(origin + path, {
      headers: cookie ? { cookie: `slopgrid=${cookie}` } : {},
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const html = await response.text();
    const script = html.match(
      /<script id="slopgrid-grids">([\s\S]*?)<\/script>/,
    )![1];
    const context = {
      window: {} as { __SLOPGRID_GRIDS__: GridListsBootstrap; bad?: number },
    };
    runInNewContext(script, context);
    assert.equal(context.window.bad, undefined);
    assert.ok(
      response.headers
        .get("content-security-policy")!
        .includes(
          `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
        ),
    );
    assert.match(response.headers.get("vary")!, /Cookie/);
    assert.ok(html.indexOf("slopgrid-grids") < html.indexOf('id="root"'));
    return context.window.__SLOPGRID_GRIDS__;
  }
  const first = await read("/", owner);
  assert.equal(first.owned.length, 3);
  assert.equal(first.public.length, 3);
  assert.equal(first.owned[0].data.grids[0].title, title);
  const creation = await read("/create", owner);
  assert.equal(JSON.stringify(creation), JSON.stringify(first));
  const anonymousCreation = await read("/create");
  assert.equal(anonymousCreation.owned[0].data.total, 0);
  assert.equal(anonymousCreation.public.length, 3);
  assert.equal(
    JSON.stringify(
      first.owned.flatMap((page) => page.data.grids.map((grid) => grid.id)),
    ),
    JSON.stringify(owned.slice(0, 60)),
  );
  const selected = await read("/?yourPage=2&publicPage=3", owner);
  assert.equal(
    JSON.stringify(selected.owned.map((page) => page.key)),
    "[2,3,4]",
  );
  assert.equal(
    JSON.stringify(selected.public.map((page) => page.key)),
    "[3,4,5]",
  );
  assert.equal(selected.public[0].data.grids[0].id, publicIds[40]);
  const visitor = await read("/");
  assert.equal(visitor.owned.length, 1);
  assert.equal(visitor.owned[0].data.total, 0);
  assert.equal(visitor.public.length, 3);
  assert.ok(!JSON.stringify(visitor).includes(title));
  const last = await read("/?yourPage=999&publicPage=5", owner);
  assert.equal(last.owned.length, 1);
  assert.equal(last.owned[0].key, 999);
  assert.equal(last.owned[0].data.page, 5);
  assert.equal(last.public.length, 1);
});
