import express from "express";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import matter from "gray-matter";
import { z } from "zod";
import type { Components } from "react-markdown";
import { MarkdownContent } from "../shared/markdown.js";

const metadata = z.object({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  date: z.iso.date(),
});
type BlogPost = z.infer<typeof metadata> & { slug: string; markdown: string };
const dateFormat = new Intl.DateTimeFormat("en", {
  dateStyle: "long",
  timeZone: "UTC",
});
const blogDescription =
  "Guides to comparing AI models and reviewing their outputs with Slopgrid.";
const blogComponents: Components = {
  img({ src, alt, title }) {
    if (
      typeof src === "string" &&
      /^\/blog-media\/[A-Za-z0-9_-]+\.mp4$/.test(src)
    )
      return (
        <video
          src={src}
          title={title}
          controls
          playsInline
          preload="metadata"
          aria-label={alt?.trim() || "Recorded walkthrough"}
        >
          <a href={src}>Open recording</a>
        </video>
      );
    return <img src={src || undefined} alt={alt} title={title} />;
  },
};

function articlePath(post: BlogPost) {
  return `/blog/${post.slug}/`;
}

function publicationDate(post: BlogPost) {
  return (
    <time dateTime={post.date}>{dateFormat.format(new Date(post.date))}</time>
  );
}

function blogDocument(origin: URL, posts: BlogPost[], post?: BlogPost) {
  const path = post ? articlePath(post) : "/blog/";
  const canonical = new URL(path, origin).href;
  const title = `${post?.title ?? "Blog"} | slopgrid`;
  const description = post?.description ?? blogDescription;
  const structuredData = JSON.stringify(
    post
      ? {
          "@context": "https://schema.org",
          "@type": "BlogPosting",
          headline: post.title,
          description,
          datePublished: post.date,
          url: canonical,
          mainEntityOfPage: canonical,
          publisher: {
            "@type": "Organization",
            name: "slopgrid",
            url: origin.origin,
          },
        }
      : {
          "@context": "https://schema.org",
          "@type": "Blog",
          name: "Slopgrid blog",
          description,
          url: canonical,
          blogPost: posts.map((article) => ({
            "@type": "BlogPosting",
            headline: article.title,
            datePublished: article.date,
            url: new URL(articlePath(article), origin).href,
          })),
        },
  ).replaceAll("<", "\\u003c");
  const html =
    "<!doctype html>" +
    renderToStaticMarkup(
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{title}</title>
          <meta name="description" content={description} />
          <link rel="canonical" href={canonical} />
          <link rel="icon" type="image/svg+xml" href="/slopgrid.svg" />
          <link rel="stylesheet" href="/blog.css" />
          <meta property="og:title" content={title} />
          <meta property="og:description" content={description} />
          <meta property="og:url" content={canonical} />
          <meta property="og:type" content={post ? "article" : "website"} />
          <meta property="og:site_name" content="slopgrid" />
          {post && (
            <meta property="article:published_time" content={post.date} />
          )}
          <meta name="twitter:card" content="summary" />
          <meta name="twitter:title" content={title} />
          <meta name="twitter:description" content={description} />
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: structuredData }}
          />
        </head>
        <body>
          <header className="site-header">
            <a className="wordmark" href="/" aria-label="slopgrid">
              <img src="/slopgrid.svg" alt="" width="30" height="30" />
              <span>
                slop<span>grid</span>
              </span>
            </a>
            <nav aria-label="Main navigation">
              <a href="/blog/" aria-current={post ? undefined : "page"}>
                Blog
              </a>
              <a href="/create">Compare models</a>
            </nav>
          </header>
          <main>
            {post ? (
              <article>
                <h1>{post.title}</h1>
                {publicationDate(post)}
                <div className="article-body">
                  <MarkdownContent
                    markdown={post.markdown}
                    components={blogComponents}
                  />
                </div>
              </article>
            ) : (
              <>
                <h1>Blog</h1>
                <p className="description">{description}</p>
                <ul className="article-list">
                  {posts.map((article) => (
                    <li key={article.slug}>
                      {publicationDate(article)}
                      <h2>
                        <a href={articlePath(article)}>{article.title}</a>
                      </h2>
                      <p>{article.description}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </main>
          <footer>
            <a href="/blog/">Blog</a>
            {" · "}
            <a href="https://github.com/klntsky/slopgrid">source code</a>
            {" · "}
            follow <a href="https://twitter.com/klntsky">@klntsky</a> for
            updates
          </footer>
        </body>
      </html>,
    );
  return {
    html,
    hash: createHash("sha256").update(structuredData).digest("base64"),
  };
}

function xml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character]!,
  );
}

export function createBlogRoutes(
  origin: URL,
  directory = fileURLToPath(new URL("../blog/", import.meta.url)),
) {
  const posts = readdirSync(directory)
    .filter((file) => file.endsWith(".md"))
    .map((file): BlogPost => {
      const slug = file.slice(0, -3);
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug === "index")
        throw new Error(`Invalid blog article filename: ${file}`);
      const source = matter(readFileSync(join(directory, file), "utf8"));
      const parsed = metadata.safeParse(source.data);
      if (!parsed.success)
        throw new Error(
          `Invalid blog metadata in ${file}: ${parsed.error.message}`,
        );
      if (!source.content.trim())
        throw new Error(`Empty blog article: ${file}`);
      return { ...parsed.data, slug, markdown: source.content };
    })
    .sort(
      (a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug),
    );
  const pages = new Map([
    ["/blog/", blogDocument(origin, posts)],
    ...posts.map(
      (post) => [articlePath(post), blogDocument(origin, posts, post)] as const,
    ),
  ]);
  const sitemap =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    ["/", ...pages.keys()]
      .map((path) => `<url><loc>${xml(new URL(path, origin).href)}</loc></url>`)
      .join("") +
    "</urlset>";
  const routes = express.Router({ strict: true, caseSensitive: true });
  routes.all(/^\/blog(?:\/.*)?$/, (req, res) => {
    res.set("Cache-Control", "public, max-age=0, must-revalidate");
    if (req.method !== "GET" && req.method !== "HEAD")
      return res
        .set("Allow", "GET, HEAD")
        .status(405)
        .send("Method not allowed");
    const path = req.path;
    const canonical = path.endsWith("/index.html")
      ? path.slice(0, -10)
      : path.endsWith("/")
        ? path
        : `${path}/`;
    const page = pages.get(canonical);
    if (!page) return res.status(404).type("text").send("Not found");
    if (path !== canonical) return res.redirect(308, canonical);
    res.set(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'sha256-${page.hash}'; style-src 'self'; img-src 'self' https: data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    return res.type("html").send(page.html);
  });
  routes.get("/sitemap.xml", (_req, res) => {
    res.set("Cache-Control", "public, max-age=0, must-revalidate");
    res.type("application/xml").send(sitemap);
  });
  return routes;
}
