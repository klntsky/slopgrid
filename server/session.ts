import type { Request, Response } from "express";
import { token } from "./ids.js";
import { createHash } from "node:crypto";
import type { Store, Session } from "./store.js";

// Browsers cap persistent cookies at 400 days; renew them during use.
export const cookieMaxAge = 400 * 86400000;

// A cache partition identifier is not an authentication credential.
export function cacheScope(session?: Pick<Session, "id">) {
  return session
    ? createHash("sha256").update(`offline:${session.id}`).digest("hex")
    : "public";
}

export function anonymousOwner(s: Session) {
  return s.anonymousId ?? s.id;
}

export function createSessionReader(
  store: Store,
  origin: URL,
  cookieName = origin.protocol === "https:" ? "__Host-slopgrid" : "slopgrid",
) {
  const secure = origin.protocol === "https:";
  if (
    !/^[A-Za-z0-9_-]+$/.test(cookieName) ||
    (secure && !cookieName.startsWith("__Host-"))
  )
    throw new Error("Invalid session cookie name");
  function cookie(res: Response, id: string) {
    res.set("X-Slopgrid-Cache-Scope", cacheScope({ id }));
    // Rotation replaces any renewal already added to this response.
    const existing = res.getHeader("Set-Cookie");
    if (existing)
      res.setHeader(
        "Set-Cookie",
        (Array.isArray(existing) ? existing : [String(existing)]).filter(
          (value) => !value.startsWith(`${cookieName}=`),
        ),
      );
    res.cookie(cookieName, id, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: cookieMaxAge,
    });
  }
  function read(req: Request): Session | undefined {
    const value = req
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    return value && /^[a-f0-9]{48}$/.test(value)
      ? store.session(value)
      : undefined;
  }
  function session(req: Request, res: Response): Session {
    let s = read(req);
    if (!s) {
      s = { id: token(), created: Date.now() };
      store.saveSession(s);
    }
    cookie(res, s.id);
    return s;
  }
  session.read = read;
  session.rotate = (s: Session, res: Response, userId?: string) => {
    const next: Session = {
      ...s,
      id: token(),
      anonymousId: anonymousOwner(s),
      userId,
      created: Date.now(),
    };
    delete next.identityOAuth;
    delete next.keyOAuth;
    store.db.transaction(() => {
      store.saveSession(next);
      store.deleteSession(s.id);
    })();
    cookie(res, next.id);
    return next;
  };
  return session;
}
export type SessionReader = ReturnType<typeof createSessionReader>;
