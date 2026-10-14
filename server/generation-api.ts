import { z } from "zod";
import type { Grid } from "./domain.js";
import type { GridVersion } from "../shared/grid-version.js";

// Version this contract when a web release cannot talk to the running engine.
export const generationProtocol = 6;
const id = z.string().min(1).max(200);
export const startGridRequest = z.strictObject({
  gridId: id,
  sessionId: id,
  manualKey: z.string().min(1).max(4096).optional(),
});
export const pauseGridRequest = z.strictObject({ gridId: id, sessionId: id });
export const previewRequest = z.strictObject({
  cellId: id,
  path: z.string().max(4096),
});
export type GenerationStatus = {
  protocol: typeof generationProtocol;
  instance: string;
  draining: boolean;
  runningCalls: number;
  activeGrids: number;
};
export const generationError = z.strictObject({
  code: z.enum([
    "DRAINING",
    "NOT_FOUND",
    "PUBLISHED",
    "AUTH_REQUIRED",
    "INVALID_REQUEST",
    "UNAVAILABLE",
  ]),
  error: z.string(),
});
export type GenerationError = z.infer<typeof generationError>;
export function generationFailure(
  code: GenerationError["code"],
  error: string,
) {
  return Object.assign(new Error(error), { code });
}
export const generationErrorStatus: Record<GenerationError["code"], number> = {
  DRAINING: 503,
  NOT_FOUND: 404,
  PUBLISHED: 409,
  AUTH_REQUIRED: 401,
  INVALID_REQUEST: 400,
  UNAVAILABLE: 503,
};

export type GenerationSnapshot = Grid & {
  version: GridVersion;
  spentUsd: number;
  live: boolean;
};

/** Private, local API. It never accepts mutable grid objects or arbitrary store operations. */
export type GenerationAPI = {
  startGrid(
    request: z.infer<typeof startGridRequest>,
  ): Promise<GenerationSnapshot>;
  pauseGrid(
    request: z.infer<typeof pauseGridRequest>,
  ): Promise<GenerationSnapshot>;
  getGrid(gridId: string): Promise<GenerationSnapshot>;
  previewPath(
    request: z.infer<typeof previewRequest>,
  ): Promise<string | undefined>;
  subscribeGrid(
    gridId: string,
    snapshot: (grid: GenerationSnapshot) => void,
    disconnected: () => void,
  ): () => void;
  status(): Promise<GenerationStatus>;
  drain(): Promise<GenerationStatus>;
  accept(): Promise<GenerationStatus>;
};
