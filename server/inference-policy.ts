import { manualKey } from "./manual-keys.js";
import type { Request, Response } from "express";
import type { Store, Session } from "./store.js";
import type { Provider } from "./provider.js";

export async function inferenceCapacity(
  provider: Provider,
  key: string,
  supplied: boolean,
) {
  const balanceUsd = supplied
    ? await provider.manualCredits(key)
    : await provider.balanceUsd(key);
  return {
    balanceUsd,
    parallelWorkers:
      balanceUsd === null ? 1 : Math.max(1, Math.floor(balanceUsd / 3)),
  };
}

export function createInferenceGuard(store: Store, provider: Provider) {
  async function allowInference(
    req: Request,
    res: Response,
    s: Session,
    parallelWorkers?: number,
  ) {
    const supplied = manualKey(req);
    let capacity: Awaited<ReturnType<typeof inferenceCapacity>>;
    try {
      capacity = await inferenceCapacity(
        provider,
        supplied ?? s.key!,
        supplied !== undefined,
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
    current.inferenceConcurrency = parallelWorkers ?? capacity.parallelWorkers;
    store.saveSession(current);
    return true;
  }
  return allowInference;
}
