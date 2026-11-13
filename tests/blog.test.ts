import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { createBlogRoutes } from "../server/blog.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../shared/markdown.js";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type PostFixture = {
  slug: string;
  title: string;
  description: string;
  date: string;
  body: string;
};

const canonicalOrigin = new URL("https://slopgrid.example");

function writePost(directory: string, post: PostFixture) {
  writeFileSync(
    join(directory, `${post.slug}.md`),
    `---\ntitle: ${JSON.stringify(post.title)}\ndescription: ${JSON.stringify(post.description)}\ndate: ${JSON.stringify(post.date)}\n---\n\n${post.body}\n`,
  );
}

function elements(node: HtmlNode, tagName?: string): HtmlElement[] {
  const found: HtmlElement[] = [];
  if ("tagName" in node && (!tagName || node.tagName === tagName))
    found.push(node);
  if ("childNodes" in node)
    for (const child of node.childNodes)
      found.push(...elements(child, tagName));
  return found;
}

function attribute(node: HtmlElement, name: string) {
  return node.attrs.find((attr) => attr.name === name)?.value;
}

function text(node: HtmlNode): string {
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(text).join("") : "";
}

function one(node: HtmlNode, tagName: string) {
  const matches = elements(node, tagName);
  assert.equal(matches.length, 1, `expected one ${tagName}`);
  return matches[0];
}

function meta(node: HtmlNode, key: string, value: string) {
  const matches = elements(node, "meta").filter(
    (element) => attribute(element, key) === value,
  );
  assert.equal(matches.length, 1, `expected one meta ${key}=${value}`);
  const content = attribute(matches[0], "content");
  assert.ok(content, `expected content for ${value}`);
  return content;
}

function assertPageMetadata(
  document: HtmlNode,
  canonical: string,
  expected?: { title: string; description: string },
) {
  assert.equal(attribute(one(document, "html"), "lang"), "en");
  const title = text(one(document, "title"));
  const description = meta(document, "name", "description");
  assert.ok(title.trim());
  if (expected) {
    assert.ok(title.includes(expected.title));
    assert.equal(description, expected.description);
  }
  const links = elements(document, "link");
  const canonicals = links.filter(
    (element) => attribute(element, "rel") === "canonical",
  );
  assert.equal(canonicals.length, 1);
  assert.equal(attribute(canonicals[0], "href"), canonical);
  assert.ok(
    links.some(
      (element) =>
        attribute(element, "rel") === "stylesheet" &&
        attribute(element, "href") === "/blog.css",
    ),
  );
  assert.equal(meta(document, "property", "og:url"), canonical);
  const ogTitle = meta(document, "property", "og:title");
  assert.ok(expected ? ogTitle.includes(expected.title) : ogTitle.trim());
  assert.equal(meta(document, "property", "og:description"), description);
  assert.ok(meta(document, "name", "twitter:card"));
  const twitterTitle = meta(document, "name", "twitter:title");
  assert.ok(
    expected ? twitterTitle.includes(expected.title) : twitterTitle.trim(),
  );
  assert.equal(meta(document, "name", "twitter:description"), description);
  assert.ok(
    elements(document, "a").some(
      (element) =>
        attribute(element, "href") === "/" && /Slopgrid/i.test(text(element)),
    ),
  );
  assert.ok(
    elements(document, "nav").some((nav) =>
      elements(nav, "a").some(
        (element) =>
          attribute(element, "href") === "/blog/" &&
          /Blog/i.test(text(element)),
      ),
    ),
  );
  for (const script of elements(document, "script"))
    assert.equal(attribute(script, "type"), "application/ld+json");
}

function blogPosting(document: HtmlNode) {
  const scripts = elements(document, "script").filter(
    (element) => attribute(element, "type") === "application/ld+json",
  );
  assert.equal(scripts.length, 1);
  const data = JSON.parse(text(scripts[0]));
  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "BlogPosting");
  return data;
}

async function serve(router: express.Router, downstream?: string) {
  const app = express();
  app.use(router);
  if (downstream) app.use(express.static(downstream));
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      server.close(() => resolve());
      return promise;
    },
  };
}

const richPost: PostFixture = {
  slug: "compare-models",
  title: "Compare models fairly",
  description: "Use one prompt and compare the results.",
  date: "2026-11-12",
  body: [
    "## Shared prompt",
    "",
    "Compare **quality** with *care* and [a useful guide](https://example.com/guide).",
    "",
    "- Keep the prompt fixed",
    "- Read every output",
    "",
    "> Use representative cases.",
    "",
    "| Model | Result |",
    "| --- | --- |",
    "| Alpha | Useful |",
    "",
    "```js",
    "const prompt = '<shared>';",
    "```",
  ].join("\n"),
};

test("blog publishes ordered HTML, rich Markdown, canonical metadata, sitemap, HEAD and redirects", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-blog-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const posts = [
    {
      ...richPost,
      slug: "older-post",
      title: "Older post",
      date: "2026-10-01",
    },
    { ...richPost, slug: "zebra-models", title: "Same-day later slug" },
    richPost,
  ];
  for (const post of posts) writePost(directory, post);
  const server = await serve(
    await createBlogRoutes(canonicalOrigin, directory),
  );
  t.after(server.close);

  const indexResponse = await fetch(`${server.origin}/blog/`);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.headers.get("content-type")!, /text\/html/);
  const index = parse(await indexResponse.text());
  assertPageMetadata(index, `${canonicalOrigin.origin}/blog/`);
  one(index, "main");
  const articleLinks = elements(index, "a").filter((element) =>
    posts.some((post) => attribute(element, "href") === `/blog/${post.slug}/`),
  );
  assert.deepEqual(
    articleLinks.map((element) => attribute(element, "href")),
    ["/blog/compare-models/", "/blog/zebra-models/", "/blog/older-post/"],
  );
  for (const post of posts)
    assert.ok(articleLinks.some((link) => text(link).includes(post.title)));

  const articleUrl = `${server.origin}/blog/compare-models/`;
  const response = await fetch(articleUrl, {
    headers: { Host: "untrusted.example" },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/html/);
  const document = parse(await response.text());
  const canonical = `${canonicalOrigin.origin}/blog/compare-models/`;
  assertPageMetadata(document, canonical, richPost);
  assert.equal(meta(document, "property", "og:type"), "article");
  const article = one(document, "article");
  assert.equal(text(one(article, "h1")), richPost.title);
  assert.equal(attribute(one(article, "time"), "datetime"), richPost.date);
  assert.equal(text(one(article, "h2")), "Shared prompt");
  assert.equal(text(one(article, "strong")), "quality");
  assert.equal(text(one(article, "em")), "care");
  assert.equal(elements(one(article, "ul"), "li").length, 2);
  assert.equal(
    text(one(article, "blockquote")).trim(),
    "Use representative cases.",
  );
  assert.deepEqual(elements(one(article, "table"), "th").map(text), [
    "Model",
    "Result",
  ]);
  assert.deepEqual(elements(one(article, "table"), "td").map(text), [
    "Alpha",
    "Useful",
  ]);
  assert.equal(
    text(one(one(article, "pre"), "code")),
    "const prompt = '<shared>';\n",
  );
  assert.ok(
    elements(article, "a").some(
      (link) => attribute(link, "href") === "https://example.com/guide",
    ),
  );
  const data = blogPosting(document);
  assert.equal(data.headline, richPost.title);
  assert.equal(data.description, richPost.description);
  assert.equal(data.datePublished, richPost.date);
  assert.ok(
    data.url === canonical ||
      data.mainEntityOfPage === canonical ||
      data.mainEntityOfPage?.["@id"] === canonical,
  );

  for (const path of ["/blog/", "/blog/compare-models/", "/sitemap.xml"]) {
    const get = await fetch(server.origin + path);
    await get.text();
    const head = await fetch(server.origin + path, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(
      head.headers.get("content-type"),
      get.headers.get("content-type"),
    );
    assert.equal(await head.text(), "");
  }
  for (const [path, target] of [
    ["/blog", "/blog/"],
    ["/blog/compare-models", "/blog/compare-models/"],
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const redirect = await fetch(server.origin + path, {
        method,
        redirect: "manual",
      });
      assert.equal(redirect.status, 308);
      assert.equal(
        new URL(redirect.headers.get("location")!, server.origin).pathname,
        target,
      );
    }
  }
  const sitemap = await fetch(`${server.origin}/sitemap.xml`);
  assert.equal(sitemap.status, 200);
  assert.match(
    sitemap.headers.get("content-type")!,
    /(?:application|text)\/xml/,
  );
  const xml = await sitemap.text();
  assert.match(
    xml,
    /<urlset\b[^>]*xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9"/,
  );
  assert.deepEqual(
    [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((match) => match[1]).sort(),
    ["/", "/blog/", ...posts.map((post) => `/blog/${post.slug}/`)]
      .map((path) => canonicalOrigin.origin + path)
      .sort(),
  );
});

test("blog snapshots survive source changes and removed or unknown posts cannot fall through to stale static HTML", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-blog-snapshot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const stale = join(directory, "public");
  mkdirSync(source);
  for (const slug of [richPost.slug, "unknown-post"]) {
    mkdirSync(join(stale, "blog", slug, "nested"), { recursive: true });
    writeFileSync(
      join(stale, "blog", slug, "index.html"),
      "Stale published article",
    );
    writeFileSync(
      join(stale, "blog", slug, "nested", "index.html"),
      "Stale nested article",
    );
  }
  writePost(source, richPost);
  const first = await serve(
    await createBlogRoutes(canonicalOrigin, source),
    stale,
  );
  t.after(first.close);
  const original = await (
    await fetch(`${first.origin}/blog/${richPost.slug}/`)
  ).text();
  writePost(source, {
    ...richPost,
    title: "Changed after startup",
    body: "Changed body",
  });
  assert.equal(
    await (await fetch(`${first.origin}/blog/${richPost.slug}/`)).text(),
    original,
  );
  rmSync(join(source, `${richPost.slug}.md`));
  assert.equal(
    await (await fetch(`${first.origin}/blog/${richPost.slug}/`)).text(),
    original,
  );

  const second = await serve(
    await createBlogRoutes(canonicalOrigin, source),
    stale,
  );
  t.after(second.close);
  for (const path of [
    `/blog/${richPost.slug}`,
    `/blog/${richPost.slug}/`,
    `/blog/${richPost.slug}/index.html`,
    `/blog/${richPost.slug}/nested/`,
    "/blog/unknown-post",
    "/blog/unknown-post/",
    "/blog/unknown-post/index.html",
    "/blog/unknown-post/nested/",
  ]) {
    const response = await fetch(second.origin + path, { redirect: "manual" });
    assert.equal(response.status, 404, `GET ${path}`);
  }
  const missingHead = await fetch(`${second.origin}/blog/${richPost.slug}/`, {
    method: "HEAD",
    redirect: "manual",
  });
  assert.equal(missingHead.status, 404);
  assert.equal(await missingHead.text(), "");
  const index = parse(await (await fetch(`${second.origin}/blog/`)).text());
  assert.ok(
    !elements(index, "a").some(
      (link) => attribute(link, "href") === `/blog/${richPost.slug}/`,
    ),
  );
  const sitemap = await (await fetch(`${second.origin}/sitemap.xml`)).text();
  assert.deepEqual(
    [...sitemap.matchAll(/<loc>([^<]*)<\/loc>/g)]
      .map((match) => match[1])
      .sort(),
    [`${canonicalOrigin.origin}/`, `${canonicalOrigin.origin}/blog/`].sort(),
  );
});

test("blog renders only local recorded videos while metadata, images and unsafe Markdown stay protected", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-blog-security-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const payload =
    'A "quoted" <label> & </script><script>alert("injected")</script>';
  const videoUrl = "/blog-media/dubai-axes.mp4";
  const untrustedMedia = [
    "https://example.com/dubai-axes.mp4",
    "//example.com/blog-media/dubai-axes.mp4",
    "https://slopgrid.example/blog-media/dubai-axes.mp4",
    "/blog-media-extra/dubai-axes.mp4",
    "/blog-media/nested/dubai-axes.mp4",
    "/blog-media/.hidden.mp4",
    "/blog-media/dubai-axes.mp4/extra",
    "blog-media/dubai-axes.mp4",
    `${videoUrl}?untrusted=1`,
  ];
  const post = {
    ...richPost,
    title: payload,
    description: `Description ${payload}`,
    body: [
      "[unsafe link](javascript:alert%281%29)",
      "[safe link](https://example.com/safe)",
      '<script>alert("raw")</script>',
      `<video src="${videoUrl}" autoplay onplay="alert(1)"></video>`,
      `![Configure row cases and model columns](${videoUrl})`,
      "![Grid overview](/blog-media/dubai-overview.webp)",
      "![External screenshot](https://example.com/screenshot.png)",
      ...untrustedMedia.map((url) => `![Untrusted recording](${url})`),
      "![Unsafe recording](javascript:alert%281%29)",
      `[Open recording](${videoUrl})`,
    ].join("\n\n"),
  };
  writePost(directory, post);
  const server = await serve(
    await createBlogRoutes(canonicalOrigin, directory),
  );
  t.after(server.close);
  for (const path of ["/blog/", `/blog/${post.slug}/`]) {
    const response = await fetch(server.origin + path);
    assert.equal(response.status, 200);
    const document = parse(await response.text());
    const csp = response.headers.get("content-security-policy");
    assert.ok(csp);
    const mediaSources = csp
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .find(([directive]) => directive === "media-src")
      ?.slice(1);
    assert.ok(mediaSources);
    assert.deepEqual(mediaSources, ["'self'"]);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'sha256-[^']+'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assertPageMetadata(
      document,
      canonicalOrigin.origin + path,
      path === "/blog/" ? undefined : post,
    );
    for (const element of elements(document)) {
      assert.ok(!element.attrs.some((attr) => /^on/i.test(attr.name)));
      for (const name of ["href", "src", "action"])
        assert.ok(!/^\s*javascript:/i.test(attribute(element, name) ?? ""));
    }
    assert.equal(elements(document, "label").length, 0);
    if (path !== "/blog/") {
      const article = one(document, "article");
      assert.equal(text(one(article, "h1")), payload);
      const video = one(article, "video");
      assert.equal(attribute(video, "src"), videoUrl);
      assert.equal(attribute(video, "controls"), "");
      assert.equal(attribute(video, "playsinline"), "");
      assert.equal(attribute(video, "preload"), "metadata");
      assert.equal(
        attribute(video, "aria-label"),
        "Configure row cases and model columns",
      );
      assert.equal(attribute(video, "autoplay"), undefined);
      const fallback = one(video, "a");
      assert.equal(attribute(fallback, "href"), videoUrl);
      assert.match(text(fallback), /open|download/i);
      const images = elements(article, "img");
      for (const image of images) assert.notEqual(attribute(image, "src"), "");
      for (const [src, alt] of [
        ["/blog-media/dubai-overview.webp", "Grid overview"],
        ["https://example.com/screenshot.png", "External screenshot"],
        ...untrustedMedia.map((url) => [url, "Untrusted recording"]),
      ])
        assert.ok(
          images.some(
            (image) =>
              attribute(image, "src") === src &&
              attribute(image, "alt") === alt,
          ),
          `expected unchanged image ${src}`,
        );
      assert.ok(
        elements(article, "a").some(
          (link) =>
            attribute(link, "href") === videoUrl &&
            text(link) === "Open recording",
        ),
      );
      assert.ok(
        text(article).includes(
          `<video src="${videoUrl}" autoplay onplay="alert(1)"></video>`,
        ),
      );
      assert.equal(elements(article, "iframe").length, 0);
      assert.ok(text(article).includes("unsafe link"));
      assert.ok(
        elements(article, "a").some(
          (link) => attribute(link, "href") === "https://example.com/safe",
        ),
      );
      const data = blogPosting(document);
      assert.equal(data.headline, payload);
      assert.equal(data.description, post.description);
    }
  }
  const generatedOutput = parse(
    renderToStaticMarkup(
      createElement(MarkdownContent, {
        markdown: `![Configure axes](${videoUrl})`,
      }),
    ),
  );
  assert.equal(elements(generatedOutput, "video").length, 0);
  assert.equal(attribute(one(generatedOutput, "img"), "src"), videoUrl);
});

test("blog initialization rejects malformed metadata, calendar dates and filename slugs", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "slopgrid-blog-invalid-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const valid = `title: "Valid title"\ndescription: "Valid description"\ndate: "2026-11-12"`;
  const cases = [
    {
      name: "missing title",
      metadata: 'description: "Description"\ndate: "2026-11-12"',
    },
    { name: "blank title", metadata: valid.replace('"Valid title"', '"  "') },
    {
      name: "non-string description",
      metadata: valid.replace('"Valid description"', "42"),
    },
    {
      name: "missing description",
      metadata: 'title: "Title"\ndate: "2026-11-12"',
    },
    {
      name: "missing date",
      metadata: 'title: "Title"\ndescription: "Description"',
    },
    {
      name: "unquoted date",
      metadata: valid.replace('"2026-11-12"', "2026-11-12"),
    },
    {
      name: "invalid calendar date",
      metadata: valid.replace("2026-11-12", "2026-02-30"),
    },
    {
      name: "non-padded date",
      metadata: valid.replace("2026-11-12", "2026-1-2"),
    },
    {
      name: "invalid YAML",
      metadata: 'title: "Unclosed\ndescription: "Description"',
    },
    ...[
      "Upper-case",
      "under_score",
      "double--hyphen",
      "-leading",
      "trailing-",
    ].map((slug) => ({
      name: `invalid slug ${slug}`,
      metadata: valid,
      slug,
    })),
  ];
  for (const [index, fixture] of cases.entries()) {
    const source = join(directory, String(index));
    mkdirSync(source);
    writePost(source, richPost);
    writeFileSync(
      join(source, `${"slug" in fixture ? fixture.slug : "invalid-post"}.md`),
      `---\n${fixture.metadata}\n---\n\nBody\n`,
    );
    assert.throws(
      () => createBlogRoutes(canonicalOrigin, source),
      fixture.name,
    );
  }
});
