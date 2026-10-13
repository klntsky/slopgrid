import type { Request, Response } from "express";
import { encrypt, decrypt } from "./encryption.js";
import { token } from "./ids.js";
import { canViewGrid } from "./grid-policy.js";
import { safePath } from "./files.js";
import type { Store, Session } from "./store.js";
import { cookieMaxAge, type SessionReader } from "./session.js";
import type { createHtmlHosts } from "./hosts.js";

export function createOutputAccess(
  store: Store,
  session: SessionReader,
  hosts: ReturnType<typeof createHtmlHosts>,
  secret: Buffer,
) {
  const cookieName = "__Host-slopgrid-output";
  const grants = new Map<
    string,
    {
      sessionId: string;
      owner: string;
      cellId: string;
      path: string;
      expires: number;
    }
  >();
  function grant(current: Session, cellId: string, path: string) {
    const now = Date.now();
    for (const [id, grant] of grants)
      if (grant.expires <= now) grants.delete(id);
    const ownerId = current.userId ?? current.anonymousId ?? current.id;
    if (
      grants.size >= 1000 ||
      [...grants.values()].filter((grant) => grant.owner === ownerId).length >=
        128
    )
      return;
    // Bridge the app session to one isolated cell host without sharing the app cookie.
    const id = token();
    grants.set(id, {
      sessionId: current.id,
      owner: ownerId,
      cellId,
      path,
      expires: now + 30000,
    });
    return id;
  }
  function viewer(req: Request, cellId: string) {
    const value = req
      .get("cookie")
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    if (!value) return;
    try {
      const [scope, sessionId] = JSON.parse(
        decrypt(decodeURIComponent(value), secret),
      );
      // The cookie references a live session, so rotation or deletion revokes access
      // even while the browser still holds the encrypted cookie.
      if (scope === cellId && typeof sessionId === "string")
        return store.session(sessionId);
    } catch {
      return undefined;
    }
  }
  return {
    open(req: Request, res: Response) {
      res.set("Cache-Control", "no-store");
      const cellId = String(req.params.id);
      const owner = store.outputMetadata(cellId);
      const current = session.read(req);
      const path =
        typeof req.query.path === "string" ? req.query.path : "index.html";
      if (
        !owner ||
        owner.format !== "html" ||
        !canViewGrid(owner, current) ||
        !safePath(path)
      )
        return res.sendStatus(404);
      const target = new URL(hosts.url(cellId));
      if (owner.published) {
        target.pathname = "/" + path;
        return res.redirect(target.href);
      }
      const id = grant(current!, cellId, path);
      if (!id) return res.sendStatus(429);
      target.pathname = `/__session/${id}`;
      res.redirect(target.href);
    },
    redeem(req: Request, res: Response, cellId: string) {
      const id = req.path.slice("/__session/".length);
      const grant = grants.get(id);
      if (!grant || grant.cellId !== cellId) return res.sendStatus(404);
      const output = store.outputMetadata(cellId);
      if (
        grant.expires <= Date.now() ||
        !output ||
        !canViewGrid(output, store.session(grant.sessionId))
      ) {
        grants.delete(id);
        return res.sendStatus(404);
      }
      res.cookie(
        cookieName,
        encrypt(JSON.stringify([cellId, grant.sessionId]), secret),
        {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          partitioned: true,
          path: "/",
          maxAge: cookieMaxAge,
        },
      );
      if (req.get("sec-fetch-dest") === "document") {
        grants.delete(id);
        return res.redirect(303, "/" + grant.path);
      }
      if (req.get("sec-fetch-mode") === "navigate") {
        // Navigation and opaque sandbox subresources use different cookie partitions.
        // Keep the grant until the bootstrap fetch sets the subresource cookie;
        // only this trusted document gets the connect-src exception. Starting the
        // fetch after load lets the parent distinguish bootstrap and output loads.
        res.set(
          "Content-Security-Policy",
          "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        );
        return res
          .type("html")
          .send(
            `<script>addEventListener("load",()=>{fetch(location.href,{credentials:"include"}).then(response=>{if(response.ok)location.replace(${JSON.stringify("/" + grant.path)})})})</script>`,
          );
      }
      grants.delete(id);
      if (req.get("origin") === "null") {
        res.set("Access-Control-Allow-Origin", "null");
        res.set("Access-Control-Allow-Credentials", "true");
        res.vary("Origin");
        return res.sendStatus(204);
      }
      res.redirect(303, "/" + grant.path);
    },
    document(req: Request, res: Response, cellId: string, html: string) {
      const current = viewer(req, cellId);
      if (!current) return res.sendStatus(404);
      const id = grant(current, cellId, req.path.slice(1));
      if (!id) return res.sendStatus(429);
      // Authorize in this document's opaque partition without navigating away.
      // Generated HTML adds connect-src 'none' before any generated scripts run.
      res.set(
        "Content-Security-Policy",
        String(res.get("Content-Security-Policy")).replace(
          "connect-src 'none'",
          "connect-src 'self'",
        ),
      );
      return res
        .type("html")
        .send(
          `<script>fetch("/__session/${id}",{credentials:"include"}).then(response=>{if(response.ok){document.open();document.write(${JSON.stringify(html).replaceAll("<", "\\u003c")});document.close()}})</script>`,
        );
    },
    read(req: Request, cellId: string) {
      const output = store.outputMetadata(cellId);
      if (!output || output.published) return output;
      return canViewGrid(output, viewer(req, cellId)) ? output : undefined;
    },
  };
}
export type OutputAccess = ReturnType<typeof createOutputAccess>;
