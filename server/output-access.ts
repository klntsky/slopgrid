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
      // The frame and its assets share the output origin and cookie partition.
      // Consume the grant once, then navigate without exposing it to generated code.
      grants.delete(id);
      res.redirect(303, "/" + grant.path);
    },
    read(req: Request, cellId: string) {
      const output = store.outputMetadata(cellId);
      if (!output || output.published) return output;
      return canViewGrid(output, viewer(req, cellId)) ? output : undefined;
    },
  };
}
export type OutputAccess = ReturnType<typeof createOutputAccess>;
