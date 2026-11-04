import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "../api";
import { modelCatalog } from "../model-catalog";
import { getOpenRouterKey } from "../openrouter-key";
import { queryClient } from "../queries";
import { clearDraft, creationSubmission, readDraft, saveDraft } from "./draft";
import {
  createModel,
  updateCreateModel,
  type CreateCommand,
  type CreateEvent,
} from "./model";
import { removeReferenceFile, uploadReferences } from "./reference-files";

export function useCreateMachine() {
  const navigate = useNavigate();
  const [model, setModel] = useState(() =>
    createModel({ ...readDraft(), formatSelected: true }, crypto.randomUUID()),
  );
  const current = useRef(model);
  const mounted = useRef(true);
  const requests = useRef(new Set<AbortController>());

  useEffect(() => {
    mounted.current = true;
    saveDraft(current.current.draft);
    return () => {
      mounted.current = false;
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
    };
  }, []);

  const dispatch = useCallback(
    function dispatch(event: CreateEvent): boolean {
      if (!mounted.current) return false;
      const before = current.current.draft;
      const result = updateCreateModel(current.current, event, modelCatalog);
      if (result.model !== current.current) {
        current.current = result.model;
        setModel(result.model);
      }

      function request(
        id: number,
        run: (signal: AbortSignal) => Promise<void>,
      ) {
        const controller = new AbortController();
        requests.current.add(controller);
        void run(controller.signal)
          .catch((error: unknown) => {
            if (controller.signal.aborted || !mounted.current) return;
            const lowBalance =
              error instanceof ApiError && error.code === "LOW_BALANCE"
                ? error.balanceUsd
                : undefined;
            dispatch({
              type: "submission-failed",
              id,
              message: error instanceof Error ? error.message : String(error),
              ...(lowBalance === undefined ? {} : { balanceUsd: lowBalance }),
            });
          })
          .finally(() => requests.current.delete(controller));
      }

      function execute(command: CreateCommand) {
        switch (command.type) {
          case "persist-draft":
            saveDraft(command.draft);
            break;
          case "confirm":
            dispatch({
              type: "confirmation-resolved",
              id: command.id,
              accepted: window.confirm(command.message),
            });
            break;
          case "prepare-references":
            request(command.id, async (signal) => {
              const input = await uploadReferences(
                command.input,
                (localId, image) =>
                  dispatch({ type: "reference-uploaded", localId, image }),
                signal,
              );
              if (!signal.aborted)
                dispatch({
                  type: "references-prepared",
                  id: command.id,
                  input,
                });
            });
            break;
          case "submit-grid":
            request(command.id, async (signal) => {
              const body = creationSubmission({
                ...command.input,
                sourceGridId: command.sourceGridId,
                reuseArtifacts: command.reuseArtifacts,
              });
              const grid = await api<{ id: string }>(
                "/grids",
                "POST",
                {
                  ...body,
                  continueWithLowBalance: command.continueWithLowBalance,
                },
                getOpenRouterKey(),
                signal,
              );
              if (!signal.aborted)
                dispatch({
                  type: "submission-succeeded",
                  id: command.id,
                  gridId: grid.id,
                });
            });
            break;
          case "creation-completed":
            request(command.id, async (signal) => {
              await queryClient.invalidateQueries({ queryKey: ["grids"] });
              if (signal.aborted) return;
              clearDraft();
              await navigate({
                to: "/grid/$id",
                params: { id: command.gridId },
              });
            });
            break;
          case "navigate-home":
            void navigate({ to: "/" });
            break;
          case "remove-reference-file":
            void removeReferenceFile(command.localId).catch(() => {});
            break;
        }
      }

      for (const command of result.commands) execute(command);
      return current.current.draft !== before;
    },
    [navigate],
  );

  return { model, dispatch };
}
