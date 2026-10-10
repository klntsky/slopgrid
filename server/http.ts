import { Agent } from "undici";

const dispatcher = new Agent({
  connect: { timeout: 0 },
  headersTimeout: 0,
  bodyTimeout: 0,
});

export const upstreamFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: Agent });
