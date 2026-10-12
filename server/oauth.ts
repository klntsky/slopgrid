import * as oauth from "oauth4webapi";
import { z } from "zod";
import { upstreamFetch } from "./http.js";
import type { Identity } from "./domain.js";

export type OAuthCredentials = { clientId: string; clientSecret: string };
export interface OAuthProvider {
  id: string;
  authorizationURL(
    callback: string,
    state: string,
    verifier: string,
  ): Promise<string>;
  identity(
    params: URLSearchParams,
    verifier: string,
    callback: string,
    state: string,
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
export type OAuthAttempt = {
  provider: string;
  verifier: string;
  state: string;
  startedAt: number;
  returnTo: string;
};
export function startOAuth(provider: string, returnTo: unknown): OAuthAttempt {
  return {
    provider,
    verifier: oauth.generateRandomCodeVerifier(),
    state: oauth.generateRandomState(),
    startedAt: Date.now(),
    returnTo: oauthReturnTo(returnTo),
  };
}
export function validOAuth(attempt: OAuthAttempt | undefined, state: unknown) {
  return (
    !!attempt &&
    state === attempt.state &&
    Date.now() - attempt.startedAt <= 600000
  );
}
export const codeChallenge = oauth.calculatePKCECodeChallenge;
export function githubProvider(credentials: OAuthCredentials): OAuthProvider {
  const server = {
    issuer: "https://github.com",
    token_endpoint: "https://github.com/login/oauth/access_token",
  };
  const client = { client_id: credentials.clientId };
  return {
    id: "github",
    async authorizationURL(callback, state, verifier) {
      const url = new URL("https://github.com/login/oauth/authorize");
      url.searchParams.set("client_id", credentials.clientId);
      url.searchParams.set("redirect_uri", callback);
      url.searchParams.set("scope", "");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", await codeChallenge(verifier));
      url.searchParams.set("code_challenge_method", "S256");
      return url.href;
    },
    async identity(params, verifier, callback, state) {
      const validated = oauth.validateAuthResponse(
        server,
        client,
        params,
        state,
      );
      const response = await oauth.authorizationCodeGrantRequest(
        server,
        client,
        oauth.ClientSecretPost(credentials.clientSecret),
        validated,
        callback,
        verifier,
        {
          [oauth.customFetch]: upstreamFetch,
          signal: AbortSignal.timeout(30000),
        },
      );
      const { access_token } = await oauth.processAuthorizationCodeResponse(
        server,
        client,
        response,
      );
      const profile = await upstreamFetch("https://api.github.com/user", {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${access_token}`,
          "User-Agent": "slopgrid",
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!profile.ok)
        throw new Error("GitHub profile failed", {
          cause: { code: "GITHUB_PROFILE_FAILED", status: profile.status },
        });
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
