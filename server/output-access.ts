import type { Request, Response } from "express";
import { encrypt, decrypt } from "./encryption.js";
import { token } from "./ids.js";
import { canViewGrid } from "./grid-policy.js";
import { safePath } from "./files.js";
import type { Store } from "./store.js";
import type { SessionReader } from "./session.js";
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
  function allowed(cellId: string, sessionId?: string) {
    const owner = store.outputOwner(cellId);
    return (
      !!owner &&
      canViewGrid(owner, sessionId ? store.session(sessionId) : undefined)
    );
  }
  return {
    open(req: Request, res: Response) {
      res.set("Cache-Control", "no-store");
      const cellId = String(req.params.id);
      const owner = store.outputOwner(cellId);
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
      const now = Date.now();
      for (const [id, grant] of grants)
        if (grant.expires <= now) grants.delete(id);
      const ownerId = owner.ownerUserId ?? owner.owner;
      if (
        grants.size >= 1000 ||
        [...grants.values()].filter((grant) => grant.owner === ownerId)
          .length >= 128
      )
        return res.sendStatus(429);
      const id = token();
      grants.set(id, {
        sessionId: current!.id,
        owner: ownerId,
        cellId,
        path,
        expires: now + 30000,
      });
      target.pathname = `/__session/${id}`;
      res.redirect(target.href);
    },
    redeem(req: Request, res: Response, cellId: string) {
      const id = req.path.slice("/__session/".length);
      const grant = grants.get(id);
      if (!grant || grant.cellId !== cellId) return res.sendStatus(404);
      grants.delete(id);
      if (grant.expires <= Date.now() || !allowed(cellId, grant.sessionId))
        return res.sendStatus(404);
      res.cookie(
        cookieName,
        encrypt(JSON.stringify([cellId, grant.sessionId]), secret),
        {
          httpOnly: true,
          secure: true,
          sameSite: "none",
          partitioned: true,
          path: "/",
        },
      );
      res.redirect(303, "/" + grant.path);
    },
    canRead(req: Request, cellId: string) {
      if (allowed(cellId)) return true;
      const value = req
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith(cookieName + "="))
        ?.slice(cookieName.length + 1);
      if (!value) return false;
      try {
        const [scope, sessionId] = JSON.parse(
          decrypt(decodeURIComponent(value), secret),
        );
        return (
          scope === cellId &&
          typeof sessionId === "string" &&
          allowed(cellId, sessionId)
        );
      } catch {
        return false;
      }
    },
  };
}
export type OutputAccess = ReturnType<typeof createOutputAccess>;
