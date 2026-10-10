import type { Request, Response } from "express";
import { token } from "./ids.js";
import type { Store, Session } from "./store.js";

export function createSessionReader(store: Store, origin: URL) {
  const secure = origin.protocol === "https:",
    cookieName = secure ? "__Host-slopgrid" : "slopgrid";
  function session(req: Request, res: Response): Session {
    const value = req
      .get("cookie")
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    let s =
      value && /^[a-f0-9]{48}$/.test(value) ? store.session(value) : undefined;
    if (!s) {
      s = { id: token(), created: Date.now() };
      store.saveSession(s);
      res.cookie(cookieName, s.id, {
        httpOnly: true,
        secure,
        sameSite: "lax",
        path: "/",
        maxAge: 30 * 86400000,
      });
    }
    return s;
  }
  return session;
}
export type SessionReader = ReturnType<typeof createSessionReader>;
