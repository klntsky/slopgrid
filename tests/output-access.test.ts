import { appFixture } from "./app-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { expandGrid, type Grid } from "../server/domain.js";
import { token } from "../server/ids.js";

test("private outputs require ownership, isolated grants are scoped and revoked with the session, and publishing allows sharing", async (t) => {
  const { origin, port, store, jobs } = await appFixture(t);
  const owner = token(),
    stranger = token();
  for (const id of [owner, stranger])
    store.saveSession({ id, created: Date.now() });
  const cookie = `slopgrid=${owner}`;
  function makeGrid(format: Grid["input"]["format"], running = false) {
    const input: Grid["input"] = {
      format,
      prompt: "$ROW",
      rows: { kind: "variable", values: ["cat"] },
      columns: { kind: "effort", values: ["none"] },
      model: "fixture/text",
      effort: "none",
      budgetUsd: 1,
    };
    const g: Grid = {
      id: token(),
      owner,
      revision: 0,
      input,
      status: running ? "running" : "complete",
      published: false,
      visibility: "private",
      createdAt: new Date().toISOString(),
      cells: expandGrid(input).map((c) => ({
        ...c,
        id: token(),
        status: running ? "running" : "complete",
      })),
    };
    store.insert(g);
    const cell = g.cells[0];
    if (running)
      jobs.previews.update(
        cell,
        '{"files":[{"path":"index.html","content":"<h1>Private preview</h1>"}]}',
        () => {},
      );
    else
      store.files.write(
        cell.id,
        format === "html"
          ? {
              "index.html": '<script type="module" src="app.js"></script>',
              "app.js": "export const value = 1;",
            }
          : {
              [format === "markdown"
                ? "index.md"
                : format === "svg"
                  ? "index.svg"
                  : "image"]: "private output",
            },
      );
    return g;
  }
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Promise<Response>((resolve, reject) => {
      const req = request(origin + path, { headers }, async (response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve(
          new Response(chunks.length ? Buffer.concat(chunks) : null, {
            status: response.statusCode,
            headers: Object.fromEntries(
              Object.entries(response.headers).map(([name, value]) => [
                name,
                Array.isArray(value) ? value.join(", ") : (value ?? ""),
              ]),
            ),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    });
  const isolated = (cellId: string, path: string, value?: string) =>
    get(path, {
      Host: `${cellId}-output.localhost:${port}`,
      ...(value ? { Cookie: value } : {}),
    });
  async function authorize(cellId: string, path = "index.html") {
    const entry = await get(
      `/outputs/${cellId}/website?path=${encodeURIComponent(path)}`,
      { Cookie: cookie },
    );
    assert.equal(entry.status, 302);
    const grantPath = new URL(entry.headers.get("location")!).pathname;
    const bootstrap = await get(grantPath, {
      Host: `${cellId}-output.localhost:${port}`,
      "Sec-Fetch-Mode": "navigate",
    });
    assert.equal(bootstrap.status, 200);
    const grant = await get(grantPath, {
      Host: `${cellId}-output.localhost:${port}`,
      Origin: "null",
    });
    assert.equal(grant.status, 204, await grant.text());
    assert.equal(grant.headers.get("access-control-allow-origin"), "null");
    assert.equal(grant.headers.get("access-control-allow-credentials"), "true");
    const outputCookie = grant.headers.get("set-cookie")!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=None", "Partitioned"])
      assert.ok(outputCookie.includes(flag));
    assert.ok(!outputCookie.includes("Domain="));
    assert.equal((await isolated(cellId, grantPath)).status, 404);
    return outputCookie.split(";")[0];
  }
  for (const format of ["markdown", "svg", "image", "html"] as const) {
    const grid = makeGrid(format),
      id = grid.cells[0].id;
    const thinkingId = token();
    grid.cells[0].thinkingId = thinkingId;
    store.files.appendThinking(
      id,
      thinkingId,
      "Private thinking <script>still text</script>",
    );
    store.saveGeneration(grid);
    const thinkingPath = `/outputs/${id}/thinking/${thinkingId}`;
    assert.equal(
      (await get(`/outputs/${id}/thinking/${token()}`, { Cookie: cookie }))
        .status,
      404,
    );
    const trace = await get(thinkingPath, { Cookie: cookie });
    assert.equal(
      await trace.text(),
      "Private thinking <script>still text</script>",
    );
    assert.match(trace.headers.get("content-type")!, /^text\/plain/);
    const paths = [
      thinkingPath,
      `/outputs/${id}/download`,
      format === "html" ? `/outputs/${id}/website` : `/outputs/${id}`,
      ...(format === "markdown" ? [`/outputs/${id}?raw=1`] : []),
    ];
    for (const path of paths) {
      const visitors: Record<string, string>[] = [
        {},
        { Cookie: `slopgrid=${stranger}` },
      ];
      for (const headers of visitors) {
        const denied = await get(path, headers);
        assert.equal(denied.status, 404);
        assert.equal(denied.headers.get("cache-control"), "no-store");
        assert.equal(denied.headers.get("set-cookie"), null);
      }
      assert.equal(
        (await get(path, { Cookie: cookie })).status,
        path.endsWith("website") ? 302 : 200,
      );
    }
    if (format === "html") {
      for (const path of ["/index.html", "/app.js"])
        for (const value of [
          undefined,
          cookie,
          "__Host-slopgrid-output=forged",
        ])
          assert.equal((await isolated(id, path, value)).status, 404);
      const outputCookie = await authorize(id);
      assert.equal((await isolated(id, "/app.js", outputCookie)).status, 200);
      const other = makeGrid("html");
      assert.equal(
        (await isolated(other.cells[0].id, "/index.html", outputCookie)).status,
        404,
      );
      const pending = await get(`/outputs/${id}/website`, { Cookie: cookie });
      store.deleteSession(owner);
      assert.equal(
        (await isolated(id, "/index.html", outputCookie)).status,
        404,
      );
      assert.equal(
        (await isolated(id, new URL(pending.headers.get("location")!).pathname))
          .status,
        404,
      );
      store.saveSession({ id: owner, created: Date.now() - 31 * 86400000 });
      assert.equal((await isolated(id, "/app.js", outputCookie)).status, 404);
      store.saveSession({ id: owner, created: Date.now() });
    }
    store.publish(grid.id, "unlisted", null);
    for (const path of paths)
      assert.equal(
        (await get(path)).status,
        path.endsWith("website") ? 302 : 200,
      );
  }
  const preview = makeGrid("html", true).cells[0];
  const previewPath = `__preview/${preview.preview!.attempt}/index.html`;
  assert.equal((await isolated(preview.id, "/" + previewPath)).status, 404);
  const previewCookie = await authorize(preview.id, previewPath);
  assert.equal(
    (await isolated(preview.id, "/" + previewPath, previewCookie)).status,
    200,
  );
  assert.equal(
    (await get(`/outputs/${preview.id}/download`, { Cookie: cookie })).status,
    404,
  );
  const accountGrid = makeGrid("markdown");
  store.claim(owner, "account");
  assert.equal(
    (await get(`/outputs/${accountGrid.cells[0].id}`, { Cookie: cookie }))
      .status,
    404,
  );
  store.saveSession({ id: stranger, userId: "account", created: Date.now() });
  assert.equal(
    (
      await get(`/outputs/${accountGrid.cells[0].id}`, {
        Cookie: `slopgrid=${stranger}`,
      })
    ).status,
    200,
  );
});
