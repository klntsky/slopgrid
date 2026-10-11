import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { upstreamFetch } from "./http.js";
import type { Identity } from "./domain.js";

export type OAuthCredentials = { clientId: string; clientSecret: string };
export interface OAuthProvider {
  id: string;
  authorizationURL(callback: string, state: string, verifier: string): string;
  identity(
    code: string,
    verifier: string,
    callback: string,
  ): Promise<{ subject: string; identity: Identity }>;
}
export function githubCredentials(
  clientId?: string,
  clientSecret?: string,
): OAuthCredentials {
  if (!clientId?.trim()) throw new Error("GITHUB_CLIENT_ID is required");
  if (!clientSecret?.trim())
    throw new Error("GITHUB_CLIENT_SECRET is required");
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}
export function oauthVerifier() {
  return randomBytes(32).toString("base64url");
}
export function githubProvider(credentials: OAuthCredentials): OAuthProvider {
  return {
    id: "github",
    authorizationURL(callback, state, verifier) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", credentials.clientId);
      url.searchParams.set("redirect_uri", callback);
      url.searchParams.set("scope", "");
      url.searchParams.set("state", state);
      url.searchParams.set(
        "code_challenge",
        createHash("sha256").update(verifier).digest("base64url"),
      );
      url.searchParams.set("code_challenge_method", "S256");
      return url.href;
    },
    async identity(code, verifier, callback) {
      const response = await upstreamFetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
            code,
            code_verifier: verifier,
            redirect_uri: callback,
          }),
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok) throw new Error("GitHub exchange failed");
      const { access_token } = z
        .object({ access_token: z.string().min(1) })
        .parse(await response.json());
      const profile = await upstreamFetch("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${access_token}`,
          "User-Agent": "slopgrid",
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!profile.ok) throw new Error("GitHub profile failed");
      const user = z
        .object({
          id: z.number().int().positive().safe(),
          login: z.string().regex(/^[a-zA-Z0-9-]{1,39}$/),
        })
        .parse(await profile.json());
      return {
        subject: String(user.id),
        identity: {
          provider: "github",
          username: user.login,
          profileURL: `https://github.com/${user.login}`,
        },
      };
    },
  };
}
export function oauthReturnTo(value: unknown) {
  return typeof value === "string" &&
    /^\/(?:grids|settings|billing|grid\/[a-f0-9]{48})?$/.test(value)
    ? value
    : "/settings";
}
