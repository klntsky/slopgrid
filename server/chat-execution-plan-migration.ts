import type Database from "better-sqlite3";
import type { GenerationParameters, ChatOutputMode } from "./domain.js";
import type { Model } from "./provider.js";

type StoredTask = {
  id: string;
  grid_id: string;
  kind: string;
  dependency_id: string | null;
  data: string;
};

export class InvalidHistoricalChat extends Error {
  constructor(readonly gridId: string, reason: string) {
    super(`Cannot migrate chat grid ${gridId}: ${reason}`);
  }
}

export function migrateChatExecutionPlans(
  db: Database.Database,
  models: readonly Model[],
  imageOutputs: ReadonlySet<string>,
): void {
  const catalog = new Map(models.map((model) => [model.id, model]));
  const tasks = db.prepare<[], StoredTask>(
    "SELECT id,grid_id,kind,dependency_id,data FROM workflow_tasks",
  ).all();
  const judges = new Map<string, StoredTask[]>();
  for (const task of tasks) {
    if (task.kind !== "judge" || !task.dependency_id) continue;
    const group = judges.get(task.dependency_id) ?? [];
    group.push(task);
    judges.set(task.dependency_id, group);
  }
  const update = db.prepare("UPDATE workflow_tasks SET data=? WHERE id=?");
  for (const task of tasks) {
    if (task.kind !== "generation") continue;
    const data = JSON.parse(task.data);
    const input = data.input;
    if (input.format !== "chat-template") continue;
    const model = catalog.get(input.model);
    const invalid = (reason: string): never => {
      throw new InvalidHistoricalChat(task.grid_id, reason);
    };
    if (model?.text === false)
      invalid("the generation model does not support text output");
    const messages = input.messages as GenerationParameters["messages"];
    const suppliedImages = messages?.some((message) => message.images?.length) ?? false;
    if (suppliedImages && model && model.imageInput !== true)
      invalid("the generation model cannot consume its supplied image history");
    const continuation = messages?.slice(0, -1).some((message) => message.role === "unfilled") ?? false;
    let mode: ChatOutputMode = model?.chatImageOutput &&
      (!continuation || model.imageInput === true)
      ? "text-and-images" : "text";
    for (const judgment of judges.get(task.id) ?? []) {
      const judgeInput = JSON.parse(judgment.data).input;
      const judge = catalog.get(judgeInput.model);
      if (judge && (!judge.text || !judge.structuredOutputs))
        invalid("the judging model does not support structured text output");
      const existingImages = suppliedImages || imageOutputs.has(task.id) || !!judgeInput.images?.length;
      if (existingImages && judge && judge.imageInput !== true)
        invalid("the judging model cannot consume existing images");
      if (judge?.imageInput !== true) mode = "text";
    }
    input.chatOutputMode = mode;
    update.run(JSON.stringify(data), task.id);
  }
}
