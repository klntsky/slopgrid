import type { Request, Response } from "express";
import { token } from "./ids.js";
import type { Store, Session } from "./store.js";

export const sessionMaxAge = 30 * 86400000;

export function anonymousOwner(s: Session) {
  return s.anonymousId ?? s.id;
}

export function createSessionReader(store: Store, origin: URL) {
  const secure = origin.protocol === "https:",
    cookieName = secure ? "__Host-slopgrid" : "slopgrid";
  function cookie(res: Response, id: string) {
    res.cookie(cookieName, id, {
      httpOnly: true,
      secure,
      sameSite: "lax",
      path: "/",
      maxAge: sessionMaxAge,
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
      cookie(res, s.id);
    }
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
