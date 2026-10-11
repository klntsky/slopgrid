import { manualKey } from "./manual-keys.js";
import type { Request, Response } from "express";
import type { Store, Session } from "./store.js";
import type { Provider } from "./provider.js";

export function createInferenceGuard(store: Store, provider: Provider) {
  async function allowInference(req: Request, res: Response, s: Session) {
    const supplied = manualKey(req);
    let balanceUsd: number | null;
    try {
      balanceUsd =
        supplied !== undefined
          ? await provider.manualCredits(supplied)
          : await provider.balanceUsd(s.key!);
    } catch {
      res
        .status(502)
        .json({ error: "Could not check your OpenRouter balance. Try again." });
      return false;
    }
    if (
      balanceUsd !== null &&
      balanceUsd < 3 &&
      req.body?.continueWithLowBalance !== true
    ) {
      res.status(409).json({
        code: "LOW_BALANCE",
        balanceUsd,
        error:
          "Your OpenRouter balance is below $3. Top up or continue with one generation at a time.",
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
    current.inferenceConcurrency =
      balanceUsd === null ? 1 : Math.max(1, Math.floor(balanceUsd / 3));
    store.saveSession(current);
    return true;
  }
  return allowInference;
}
