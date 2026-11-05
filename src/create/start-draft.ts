import type { GridDraftInput } from "../../server/domain";
import { modelCatalog } from "../model-catalog";
import { readDraft, saveDraft } from "./draft";
import {
  createCreationController,
  type CreationEffects,
} from "./create-controller";

export function startDraft(format: GridDraftInput["format"]) {
  const draft = readDraft();
  const controller = createCreationController(
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
  const effects: CreationEffects = {
    execute(command) {
      switch (command.type) {
        case "persist-draft":
          saveDraft(command.draft);
          break;
        case "confirm":
          controller.dispatch(
            {
              type: "confirmation-resolved",
              id: command.id,
              accepted: window.confirm(command.message),
            },
            effects,
          );
          break;
        default:
          throw new Error(
            `Unexpected format-selection command: ${command.type}`,
          );
      }
    },
  };
  controller.dispatch({ type: "format-selected", format }, effects);
}
