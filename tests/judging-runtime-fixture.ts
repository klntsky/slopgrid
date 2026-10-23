import assert from "node:assert/strict";
import {
  until,
  messageText,
  type RuntimeCall,
  type RuntimeFixture,
} from "./runtime-fixture.js";
import type { GridInput, ParameterSources } from "../server/domain.js";
import {
  currentDefinition,
  type CurrentGridOverrides,
} from "./current-grid-fixture.js";

export const judgeParameters: Partial<ParameterSources> = {
  input: {
    kind: "common",
    value: [{ role: "user", content: "Draw a red rectangle" }],
  },
  judge_model: { kind: "rows" },
  judge_effort: { kind: "columns" },
  judge_criteria: {
    kind: "common",
    value: [
      { text: "Is there a blue circle?", correctAnswer: false },
      { text: "Is there a red rectangle?", correctAnswer: true },
    ],
  },
};
export const judging: CurrentGridOverrides = {
  budgetUsd: 0.1,
  judge: true,
  parameters: judgeParameters,
  rows: [
    { judge_model: "fixture/text" },
    { judge_model: "fixture/judge-other" },
  ],
  columns: [{ judge_effort: "none" }, { judge_effort: "high" }],
  parallelWorkers: 4,
};
export const input: GridInput = currentDefinition({
  ...judging,
  parameters: {
    ...judgeParameters,
    effort: { kind: "common", value: "none" },
  },
});
export const verdicts = {
  results: [
    { verdict: false, explanation: "No blue circle." },
    { verdict: false, explanation: "No rectangle in this text." },
  ],
};
export function finish(call: RuntimeCall, content: string, cost: number) {
  call.write({ content });
  call.finish(cost);
}

export async function create(fixture: RuntimeFixture, body: unknown = input) {
  const response = await fixture.request("/api/grids", body);
  assert.equal(response.status, 201, await response.clone().text());
  return (await response.json()).id as string;
}

export const single: GridInput = currentDefinition({
  ...input,
  rows: [{ judge_model: "fixture/text" }],
  columns: [{ judge_effort: "none" }],
  parallelWorkers: 1,
});
export const pair: GridInput = currentDefinition({
  ...single,
  rows: [
    { judge_model: "fixture/text" },
    { judge_model: "fixture/judge-other" },
  ],
});
export function judgeArtifact(call: RuntimeCall): string {
  return messageText(call.request.messages.at(-3)!.content);
}
export function judgeImage(call: RuntimeCall) {
  const parts = call.request.messages.flatMap((message) =>
    typeof message.content === "string" ? [] : message.content,
  );
  const images = parts.filter((part) => part.type === "image_url");
  assert.equal(images.length, 1);
  const match = /^data:([^;]+);base64,(.+)$/.exec(images[0].image_url!.url);
  assert.ok(match);
  return { mediaType: match[1], bytes: Buffer.from(match[2], "base64") };
}
export async function settled(
  fixture: RuntimeFixture,
  id: string,
  status: "complete" | "paused" = "complete",
) {
  await until(
    () => fixture.engine.api.getGrid(id),
    (grid) => !grid.live && grid.status === status,
  );
  return fixture.store.get(id)!;
}
