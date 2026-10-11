import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api, ApiError, type ViewGrid } from "./api";
import { getOpenRouterKey } from "./openrouter-key";

export function useInferenceMutation(
  onSuccess: (grid: ViewGrid) => void | Promise<void>,
) {
  const [lowBalance, setLowBalance] = useState<number | null>(null);
  const mutation = useMutation({
    mutationFn: ({
      path,
      body,
      continueWithLowBalance = false,
    }: {
      path: string;
      body?: object;
      continueWithLowBalance?: boolean;
    }) =>
      api<ViewGrid>(
        path,
        "POST",
        { ...body, continueWithLowBalance },
        getOpenRouterKey(),
      ),
    onSuccess: async (grid) => {
      setLowBalance(null);
      await onSuccess(grid);
    },
    onError: (error) => {
      if (
        error instanceof ApiError &&
        error.code === "LOW_BALANCE" &&
        error.balanceUsd !== undefined
      )
        setLowBalance(error.balanceUsd);
    },
  });
  return {
    ...mutation,
    lowBalance,
    setLowBalance,
    message:
      mutation.error instanceof ApiError &&
      mutation.error.code === "LOW_BALANCE"
        ? ""
        : (mutation.error?.message ?? ""),
  };
}
