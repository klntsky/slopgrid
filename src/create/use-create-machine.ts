import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { api, ApiError } from "../api";
import { modelCatalog } from "../model-catalog";
import { getOpenRouterKey } from "../openrouter-key";
import { queryClient } from "../queries";
import { clearDraft, creationSubmission, readDraft, saveDraft } from "./draft";
import { createCreationController } from "./create-controller";
import type { CreateCommand, CreateEvent } from "./machine-contract";
import { removeReferenceFile, uploadReferences } from "./reference-files";

export function useCreateMachine() {
  const navigate = useNavigate();
  const [controller] = useState(() => {
    const draft = { ...readDraft(), formatSelected: true };
    return createCreationController(
      { draft, caseIdPrefix: crypto.randomUUID() },
      {
        catalog: modelCatalog,
        provider: {
          connected: false,
          capacity: {
            format: draft.input.format,
            status: "pending",
            parallelWorkers: null,
          },
        },
      },
    );
  });
  const [view, setView] = useState(() => controller.view());
  const mounted = useRef(true);
  const requests = useRef(new Set<AbortController>());

  useEffect(() => {
    mounted.current = true;
    saveDraft(controller.view().draft);
    return () => {
      mounted.current = false;
      for (const controller of requests.current) controller.abort();
      requests.current.clear();
    };
  }, [controller]);

  const dispatch = useCallback(
    function dispatch(event: CreateEvent): boolean {
      if (!mounted.current) return false;

      function request(
        id: number,
        run: (signal: AbortSignal) => Promise<void>,
        failure:
          "submission-failed" | "completion-failed" = "submission-failed",
      ) {
        const controller = new AbortController();
        requests.current.add(controller);
        void run(controller.signal)
          .catch((error: unknown) => {
            if (controller.signal.aborted || !mounted.current) return;
            const message =
              error instanceof Error ? error.message : String(error);
            if (failure === "completion-failed") {
              dispatch({ type: failure, id, message });
              return;
            }
            const lowBalance =
              error instanceof ApiError && error.code === "LOW_BALANCE"
                ? error.balanceUsd
                : undefined;
            dispatch({
              type: failure,
              id,
              message,
              balanceUsd: lowBalance ?? null,
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
              await uploadReferences(
                command.input,
                (localId, image) =>
                  dispatch({
                    type: "reference-uploaded",
                    id: command.id,
                    localId,
                    image,
                  }),
                signal,
              );
              if (!signal.aborted)
                dispatch({
                  type: "references-prepared",
                  id: command.id,
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
            request(
              command.id,
              async (signal) => {
                await queryClient.invalidateQueries({ queryKey: ["grids"] });
                if (signal.aborted) return;
                clearDraft();
                await navigate({
                  to: "/grid/$id",
                  params: { id: command.gridId },
                });
              },
              "completion-failed",
            );
            break;
          case "navigate-home":
            void navigate({ to: "/" });
            break;
          case "remove-reference-file":
            void removeReferenceFile(command.localId).catch(() => {});
            break;
        }
      }

      return controller.dispatch(event, {
        publish: setView,
        execute,
      }).draftChanged;
    },
    [controller, navigate],
  );

  return { view, dispatch };
}
