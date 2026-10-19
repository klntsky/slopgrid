import type { Cell, GridInput } from "./domain.js";
import { estimateCell, recommendWorkers } from "./cost-estimates.js";
import { manualKey } from "./manual-keys.js";
import type { Request, Response } from "express";
import type { Store, Session } from "./store.js";
import type { Provider } from "./provider.js";

export async function inferenceCapacity(
  provider: Provider,
  key: string,
  supplied: boolean,
  format: GridInput["format"] = "svg",
) {
  const balanceUsd = supplied
    ? await provider.manualCredits(key)
    : await provider.balanceUsd(key);
  return {
    balanceUsd,
    parallelWorkers:
      balanceUsd === null
        ? 1
        : Math.max(
            1,
            Math.floor((balanceUsd * 100) / (format === "image" ? 40 : 300)),
          ),
  };
}

export function createInferenceGuard(store: Store, provider: Provider) {
  async function allowInference(
    req: Request,
    res: Response,
    s: Session,
    parallelWorkers: number | undefined,
    format: GridInput["format"],
    cells: readonly Cell[] = [],
  ) {
    const supplied = manualKey(req);
    let capacity: Awaited<ReturnType<typeof inferenceCapacity>>;
    try {
      capacity = await inferenceCapacity(
        provider,
        supplied ?? s.key!,
        supplied !== undefined,
        format,
      );
    } catch {
      res
        .status(502)
        .json({ error: "Could not check your OpenRouter balance. Try again." });
      return false;
    }
    const { balanceUsd } = capacity;
    if (
      balanceUsd !== null &&
      format === "image" &&
      balanceUsd < 3 &&
      req.body?.continueWithLowBalance !== true
    ) {
      res.status(409).json({
        code: "LOW_BALANCE",
        balanceUsd,
        error:
          "Your OpenRouter balance is below $3. Top up or continue with the selected parallelism.",
      });
      return false;
    }
    let automatic = capacity.parallelWorkers;
    if (
      parallelWorkers === undefined &&
      (format !== "image" || cells.some((cell) => cell.judge))
    ) {
      const models = format === "image" ? [] : await provider.models();
      const now = new Date();
      const costs: number[] = [];
      const sources = new Set<string>();
      for (const cell of cells) {
        const sourceId = cell.generationId;
        if (!sourceId)
          throw new Error("Inference admission requires a generation task.");
        if (sources.has(sourceId)) continue;
        sources.add(sourceId);
        if (cell.artifactId) continue;
        costs.push(
          format === "image"
            ? 3
            : estimateCell(
                models.find((model) => model.id === cell.model),
                cell,
                format,
                now,
              ).costUsd,
        );
      }
      for (const cell of cells)
        if (cell.judge && cell.judge.status !== "complete") costs.push(3);
      automatic = recommendWorkers(balanceUsd, costs);
    }
    // Re-read the session so a concurrent OAuth or disconnect request is preserved.
    const current = store.session(s.id);
    if (
      !current ||
      (supplied === undefined && (!current.key || current.key !== s.key))
    ) {
      res
        .status(401)
        .json({ error: "Reconnect OpenRouter before generating." });
      return false;
    }
    current.inferenceConcurrency = parallelWorkers ?? automatic;
    store.saveSession(current);
    return true;
  }
  return allowInference;
}
