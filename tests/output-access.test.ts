import { appFixture } from "./app-fixture.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { expandGrid, type Grid } from "../server/domain.js";
import { token } from "../server/ids.js";
import { rmSync } from "node:fs";
import { createWorkflow, projectWorkflow } from "../server/workflow.js";

test("private outputs require ownership, isolated grants are scoped and revoked with the session, and publishing allows sharing", async (t) => {
  const { origin, port, store, executor } = await appFixture(t);
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
    const tasks = createWorkflow(input, g.cells);
    const generation = tasks.find((task) => task.kind === "generation")!;
    const artifactId = token();
    if (running) generation.status = "running";
    else {
      generation.status = "complete";
      generation.output = {
        artifactId,
        provenance: {
          signature: "saved-generation",
          files: [
            format === "html"
              ? "index.html"
              : format === "markdown"
                ? "index.md"
                : format === "svg"
                  ? "index.svg"
                  : "image",
          ],
        },
      };
    }
    projectWorkflow(g, tasks);
    store.insert(g, tasks);
    if (running) {
      executor.previews.update(
        generation,
        '{"files":[{"path":"index.html","content":"<h1>Private preview</h1>"}]}',
        () => projectWorkflow(g, tasks),
        () => true,
      );
    } else
      store.files.write(
        artifactId,
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
    const grant = await get(grantPath, {
      Host: `${cellId}-output.localhost:${port}`,
      "Sec-Fetch-Mode": "navigate",
    });
    assert.equal(grant.status, 303);
    assert.equal(grant.headers.get("location"), "/" + path);
    const outputCookie = grant.headers.get("set-cookie")!;
    for (const flag of ["HttpOnly", "Secure", "SameSite=None", "Partitioned"])
      assert.ok(outputCookie.includes(flag));
    assert.ok(!outputCookie.includes("Domain="));
    assert.match(outputCookie, /Max-Age=34560000;/);
    assert.equal((await isolated(cellId, grantPath)).status, 404);
    return outputCookie.split(";")[0];
  }
  for (const format of ["markdown", "svg", "image", "html"] as const) {
    const grid = makeGrid(format),
      id = grid.cells[0].id;
    const thinkingId = token();
    const tasks = store.workflow(grid.id);
    const generation = tasks.find((task) => task.kind === "generation")!;
    generation.output!.thinkingId = thinkingId;
    generation.output!.thinkingSourceId = token();
    store.files.appendThinking(
      generation.output!.thinkingSourceId,
      thinkingId,
      "Private thinking <script>still text</script>",
    );
    store.saveWorkflow(grid, tasks);
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
      ...(format === "html"
        ? [`/outputs/${id}/offline`, `/offline/outputs/${id}/index.html`]
        : []),
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
    if (format === "svg" || format === "image") {
      store.saveSession({
        id: owner,
        created: 0,
      });
      const file = await get(`/outputs/${id}`, { Cookie: cookie });
      assert.equal(file.status, 200);
      const cache = file.headers.get("cache-control")!;
      assert.equal(
        cache,
        "private, max-age=31536000, immutable, must-revalidate",
      );
      assert.equal(file.headers.get("vary"), "Cookie");
      const conditional = {
        Cookie: cookie,
        "If-None-Match": file.headers.get("etag")!,
      };
      assert.equal((await get(`/outputs/${id}`, conditional)).status, 304);
      store.deleteSession(owner);
      const revoked = await get(`/outputs/${id}`, conditional);
      assert.equal(revoked.status, 404);
      assert.equal(revoked.headers.get("cache-control"), "no-store");
      store.saveSession({ id: owner, created: Date.now() });
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
      const sharedTasks = store.workflow(other.id);
      const shared = sharedTasks.find((task) => task.kind === "generation")!;
      shared.output = structuredClone(generation.output);
      store.saveWorkflow(other, sharedTasks);
      assert.equal(
        store.outputMetadata(other.cells[0].id)?.artifactId,
        generation.output!.artifactId,
      );
      assert.equal(
        (await isolated(other.cells[0].id, "/index.html", outputCookie)).status,
        404,
      );
      const otherCookie = await authorize(other.cells[0].id);
      assert.equal(
        (await isolated(other.cells[0].id, "/app.js", otherCookie)).status,
        200,
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
      store.saveSession({ id: owner, created: 0 });
      assert.equal((await isolated(id, "/app.js", outputCookie)).status, 200);
      store.saveSession({ id: owner, created: Date.now() });
    }
    store.publish(grid.id, "unlisted", null);
    if (format === "svg" || format === "image") {
      const file = await get(`/outputs/${id}`);
      assert.equal(
        file.headers.get("cache-control"),
        "public, max-age=31536000, immutable",
      );
      assert.equal(file.headers.get("vary"), null);
      const cached = await get(`/outputs/${id}`, {
        "If-None-Match": file.headers.get("etag")!,
      });
      assert.equal(cached.status, 304);
      assert.equal(await cached.text(), "");
    }
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
  const missingId = accountGrid.cells[0].id;
  const artifactId = store.outputMetadata(missingId)!.artifactId!;
  rmSync(store.files.path(artifactId, "index.md")!);
  for (const path of [
    `/outputs/${missingId}`,
    `/outputs/${missingId}/download`,
  ])
    assert.equal(
      (await get(path, { Cookie: `slopgrid=${stranger}` })).status,
      404,
    );
});

test("committed judged outputs stay readable and downloadable without weakening ownership checks", async (t) => {
  const { origin, store } = await appFixture(t);
  const owner = token();
  const stranger = token();
  for (const id of [owner, stranger])
    store.saveSession({ id, created: Date.now() });
  const ownerHeaders = { cookie: `slopgrid=${owner}` };
  for (const format of ["markdown", "chat-template", "svg", "image"] as const) {
    for (const status of ["pending", "running", "error", "complete"] as const) {
      const input: Grid["input"] = {
        format,
        prompt: "A saved artifact",
        rows: { kind: "variable", values: ["one"] },
        columns: { kind: "effort", values: ["none"] },
        model: "fixture/text",
        effort: "none",
        budgetUsd: 1,
        judge: {
          criteria: [{ text: "Is this saved?", correctAnswer: false }],
          model: "fixture/judge",
          effort: "default",
        },
      };
      const cell = {
        ...expandGrid(input)[0],
        id: token(),
        status,
        artifactId: token(),
        mediaType: format === "image" ? "image/png" : undefined,
        judge: {
          model: "fixture/judge",
          effort: "default",
          status,
          ...(status === "error" ? { error: "Judge unavailable" } : {}),
          ...(status === "complete"
            ? {
                results: [
                  { verdict: false, explanation: "The artifact was saved." },
                ],
              }
            : {}),
        },
      };
      const filename =
        format === "markdown"
          ? "index.md"
          : format === "chat-template"
            ? "messages.json"
            : format === "svg"
              ? "index.svg"
              : "image";
      const grid: Grid = {
        id: token(),
        owner,
        input,
        status: "paused",
        published: false,
        visibility: "private",
        createdAt: new Date().toISOString(),
        cells: [cell],
      };
      const tasks = createWorkflow(input, grid.cells);
      const generation = tasks.find((task) => task.kind === "generation")!;
      const judgment = tasks.find((task) => task.kind === "judge")!;
      generation.status = "complete";
      generation.output = {
        artifactId: cell.artifactId,
        mediaType: cell.mediaType,
        provenance: { signature: "saved-generation", files: [filename] },
        thinkingId: token(),
        thinkingSourceId: token(),
      };
      judgment.status = status;
      if (status === "error") judgment.error = "Judge unavailable";
      if (status === "complete")
        judgment.output = { results: cell.judge.results! };
      projectWorkflow(grid, tasks);
      store.insert(grid, tasks);
      store.files.appendThinking(
        generation.output.thinkingSourceId!,
        generation.output.thinkingId!,
        "Saved thinking",
      );
      store.files.write(cell.artifactId, {
        [filename]:
          format === "chat-template"
            ? JSON.stringify([{ role: "assistant", content: "Saved artifact" }])
            : "Saved artifact",
      });
      const paths = [
        `/outputs/${cell.id}`,
        `/outputs/${cell.id}/download`,
        `/outputs/${cell.id}/thinking/${generation.output.thinkingId}`,
        ...(format === "markdown" || format === "chat-template"
          ? [`/outputs/${cell.id}?raw=1`]
          : []),
      ];
      for (const path of paths) {
        for (const headers of [
          new Headers(),
          new Headers({ cookie: `slopgrid=${stranger}` }),
        ]) {
          const denied = await fetch(origin + path, { headers });
          assert.equal(denied.status, 404);
          assert.equal(denied.headers.get("X-Slopgrid-Output-Ready"), null);
          assert.equal(denied.headers.get("Cache-Control"), "no-store");
        }
        const response = await fetch(origin + path, {
          headers: ownerHeaders,
        });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("X-Slopgrid-Output-Ready"), "1");
        assert.match(await response.text(), /Saved (?:artifact|thinking)/);
      }
      const view = await (
        await fetch(`${origin}/api/grids/${grid.id}`, {
          headers: ownerHeaders,
        })
      ).json();
      assert.equal(view.cells[0].outputReady, true);
      assert.equal(view.cells[0].outputURL, `${origin}/outputs/${cell.id}`);
      assert.equal(view.cells[0].status, status);
      assert.equal(view.cells[0].generationId, generation.id);
      assert.equal(view.input.judge.criteria[0].correctAnswer, false);
      const publicationError = store.publish(grid.id, "unlisted", null);
      if (status === "running") {
        assert.equal(typeof publicationError, "string");
        continue;
      }
      assert.equal(publicationError, undefined);
      const publishedView = await (
        await fetch(`${origin}/api/grids/${grid.id}`)
      ).json();
      assert.equal(publishedView.cells[0].outputReady, true);
      assert.equal(publishedView.cells[0].outputURL, view.cells[0].outputURL);
      assert.equal(publishedView.cells[0].status, status);
      assert.deepEqual(publishedView.cells[0].judge, cell.judge);
      for (const path of paths) {
        const response = await fetch(origin + path);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("X-Slopgrid-Output-Ready"), "1");
      }
    }
  }
});

test("uncommitted judged files are not exposed before generation commits", async (t) => {
  const { origin, store } = await appFixture(t);
  const owner = token();
  store.saveSession({ id: owner, created: Date.now() });
  const input: Grid["input"] = {
    format: "markdown",
    prompt: "Uncommitted artifact",
    rows: { kind: "variable", values: ["one"] },
    columns: { kind: "effort", values: ["none"] },
    model: "fixture/text",
    effort: "none",
    budgetUsd: 1,
    judge: {
      criteria: [{ text: "Is this saved?", correctAnswer: true }],
      model: "fixture/judge",
      effort: "default",
    },
  };
  const cellId = token();
  const grid: Grid = {
    id: token(),
    owner,
    input,
    status: "paused",
    published: false,
    visibility: "private",
    createdAt: new Date().toISOString(),
    cells: [
      {
        ...expandGrid(input)[0],
        id: cellId,
        status: "pending",
      },
    ],
  };
  store.insert(grid);
  store.files.write(token(), { "index.md": "Uncommitted artifact" });
  const headers = { cookie: `slopgrid=${owner}` };
  assert.equal(store.outputMetadata(cellId)?.outputReady, false);
  assert.equal(store.outputDownload(cellId), undefined);
  for (const path of [`/outputs/${cellId}`, `/outputs/${cellId}/download`]) {
    const response = await fetch(origin + path, { headers });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("X-Slopgrid-Output-Ready"), null);
  }
  const view = await (
    await fetch(`${origin}/api/grids/${grid.id}`, { headers })
  ).json();
  assert.equal(view.cells[0].outputReady, false);
  assert.equal(view.cells[0].outputURL, undefined);
});
