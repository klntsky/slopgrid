import { test } from "node:test";
import assert from "node:assert/strict";
import { APICallError } from "ai";
import { failureDetails } from "../server/failures.js";

function response(
  status: number,
  metadata?: Record<string, unknown>,
  retryAfter?: string,
) {
  return new APICallError({
    message: "SDK wrapper message",
    url: "https://provider.invalid/generate",
    requestBodyValues: { private: "Never expose this" },
    statusCode: status,
    responseHeaders: retryAfter ? { "retry-after": retryAfter } : {},
    responseBody: JSON.stringify({
      error: { code: status, message: "Provider explanation", metadata },
    }),
  });
}
test("rate limits honor Retry-After seconds and dates and preserve the provider explanation", () => {
  const limited = failureDetails(response(429, undefined, "5"));
  assert.equal(limited.temporary, true);
  assert.equal(limited.retryAfterMs, 5000);
  assert.equal(limited.code, 429);
  assert.equal(limited.message, "Provider explanation");
  const now = Date.now();
  const date = new Date(Math.ceil(now / 1000) * 1000 + 5000).toUTCString();
  assert.ok(
    failureDetails(response(429, undefined, date)).retryAfterMs! >= 4900,
  );
  assert.equal(
    failureDetails(response(429, undefined, "nonsense")).retryAfterMs,
    undefined,
  );
});
test("temporary in-flight budget limits retry while exhausted credits and oversized requests require intervention", () => {
  assert.equal(
    failureDetails(
      response(
        402,
        {
          limit_source: "openrouter_in_flight_budget",
          reason: "in_flight_budget_exhausted",
        },
        "5",
      ),
    ).temporary,
    true,
  );
  for (const metadata of [
    undefined,
    { limit_source: "openrouter_in_flight_budget" },
    { reason: "in_flight_budget_exhausted" },
    { limit_source: "openrouter_key_limit" },
    { limit_source: "openrouter_credits", reason: "weight_exceeds_budget" },
  ])
    assert.equal(failureDetails(response(402, metadata)).temporary, false);
  for (const retryAfter of ["", "nonsense"])
    assert.equal(
      failureDetails(
        response(
          402,
          { limit_source: "openrouter_in_flight_budget" },
          retryAfter,
        ),
      ).temporary,
      false,
    );
  assert.equal(failureDetails(response(500)).temporary, false);
});
test("streamed errors and local failures preserve their message and code without exposing request details", () => {
  const streamed = failureDetails({
    code: 402,
    message: "Wait for existing requests",
    metadata: {
      limit_source: "openrouter_in_flight_budget",
      headers: { "Retry-After": "5" },
    },
  });
  assert.equal(streamed.temporary, true);
  assert.equal(streamed.retryAfterMs, 5000);
  assert.equal(streamed.message, "Wait for existing requests");
  assert.equal(streamed.code, 402);
  assert.equal(failureDetails(new Error("Invalid SVG")).message, "Invalid SVG");
  assert.equal(
    failureDetails({
      code: "unsupported_effort",
      message: "Thinking effort is unsupported",
    }).code,
    "unsupported_effort",
  );
  assert.ok(
    !JSON.stringify(failureDetails(response(429))).includes(
      "Never expose this",
    ),
  );
});

test("only documented budget 403 failures pause billing", () => {
  for (const limit_source of [
    "openrouter_key_limit",
    "openrouter_workspace_budget",
    "openrouter_guardrail_budget",
  ])
    assert.equal(failureDetails(response(403, { limit_source })).billing, true);
  assert.equal(failureDetails(response(403)).billing, false);
  assert.equal(
    failureDetails(response(403, { limit_source: "content_policy" })).billing,
    false,
  );
  assert.equal(failureDetails(response(402)).billing, true);
  assert.equal(
    failureDetails(
      response(402, { limit_source: "openrouter_in_flight_budget" }, "1"),
    ).billing,
    false,
  );
});
