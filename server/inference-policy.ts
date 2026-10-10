import type { Request, Response } from "express";
import type { Store, Session } from "./store.js";
import type { Provider } from "./provider.js";

export function createInferenceGuard(store: Store, provider: Provider) {
  async function allowInference(req: Request, res: Response, s: Session) {
    let balanceUsd: number;
    try {
      balanceUsd = await provider.balanceUsd(s.key!);
    } catch {
      res
        .status(502)
        .json({ error: "Could not check your OpenRouter balance. Try again." });
      return false;
    }
    if (balanceUsd < 3 && req.body?.continueWithLowBalance !== true) {
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
    if (!current?.key || current.key !== s.key) {
      res
        .status(401)
        .json({ error: "Reconnect OpenRouter before generating." });
      return false;
    }
    if (balanceUsd < 3) current.inferenceConcurrency = 1;
    else delete current.inferenceConcurrency;
    store.saveSession(current);
    return true;
  }
  return allowInference;
}
