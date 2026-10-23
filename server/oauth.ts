import * as oauth from "oauth4webapi";
import {
  exchangeWebFlowCode,
  getWebFlowAuthorizationUrl,
} from "@octokit/oauth-methods";
import { request } from "@octokit/request";
import { z } from "zod";
import { upstreamFetch } from "./http.js";
import type { Identity } from "./domain.js";
import { isGridSlug } from "../shared/grid-slug.js";

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
): OAuthCredentials | undefined {
  if (!clientId?.trim() || !clientSecret?.trim()) return undefined;
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
  const github = request.defaults({
    headers: { "user-agent": "slopgrid" },
    request: { fetch: upstreamFetch },
  });
  return {
    id: "github",
    async authorizationURL(callback, state, verifier) {
      const { url } = getWebFlowAuthorizationUrl({
        clientType: "oauth-app",
        clientId: credentials.clientId,
        redirectUrl: callback,
        state,
        scopes: [],
      });
      const authorization = new URL(url);
      // Octokit's OAuth methods do not expose PKCE options yet.
      authorization.searchParams.set(
        "code_challenge",
        await codeChallenge(verifier),
      );
      authorization.searchParams.set("code_challenge_method", "S256");
      return authorization.href;
    },
    async identity(params, verifier, callback, state) {
      const code = params.get("code");
      if (!code || params.get("state") !== state || params.has("error"))
        throw new Error("Invalid GitHub callback");
      const { authentication } = await exchangeWebFlowCode({
        clientType: "oauth-app",
        ...credentials,
        code,
        redirectUrl: callback,
        request: github.defaults({
          code_verifier: verifier,
          request: { signal: AbortSignal.timeout(30000) },
        }),
      });
      const profile = await github("GET /user", {
        headers: { authorization: `Bearer ${authentication.token}` },
        request: { signal: AbortSignal.timeout(30000) },
      });
      const user = z
        .object({
          id: z.number().int().positive().safe(),
          login: z.string().regex(/^[a-zA-Z0-9-]{1,39}$/),
        })
        .parse(profile.data);
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
    (/^\/(?:create|grids|settings|billing|grid\/[a-f0-9]{48})?$/.test(value) ||
      (value.startsWith("/") && isGridSlug(value.slice(1))))
    ? value
    : "/settings";
}
