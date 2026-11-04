import type { GridDraftInput } from "../../server/domain";
import { modelCatalog } from "../model-catalog";
import { readDraft, saveDraft } from "./draft";
import { createModel, updateCreateModel, type CreateEvent } from "./model";

export function startDraft(format: GridDraftInput["format"]) {
  let model = createModel(readDraft(), crypto.randomUUID());
  function dispatch(event: CreateEvent) {
    const result = updateCreateModel(model, event, modelCatalog);
    model = result.model;
    for (const command of result.commands) {
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
        default:
          throw new Error(
            `Unexpected format-selection command: ${command.type}`,
          );
      }
    }
  }
  dispatch({ type: "format-selected", format });
}
