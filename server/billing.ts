import type Database from "better-sqlite3";
import type { Cell, Completion } from "./domain.js";
import { expandGrid } from "./domain.js";
import { token } from "./ids.js";
import {
  completionFailure,
  failureDetails,
  failureDiagnostics,
  type FailureDiagnostic,
} from "./failures.js";
import type { Persistence } from "./persistence.js";
import { sumUsage } from "./usage.js";

export type CallDetails = {
  attemptId?: string;
  phase: Completion["phase"];
  model?: string;
  effort?: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  finishedAt?: number;
  generationId?: string;
  httpStatus?: number;
  completion?: Completion;
  usage?: Cell["usage"];
  error?: string;
  errorCode?: string | number;
  diagnostics?: FailureDiagnostic[];
};
export type CallRecorder = {
  update: (details: Partial<CallDetails>) => void;
  complete: (completion: Completion, usage: Cell["usage"]) => void;
  fail: (error: unknown, cancelled: boolean) => void;
};
export type CallObserver = (phase: Completion["phase"]) => CallRecorder;
export type BillingCall = Omit<
  CallDetails,
  "completion" | "diagnostics" | "attemptId"
> & {
  id: string;
  startedAt: number;
  gridId: string;
  gridPrompt: string;
  model: string;
  effort: string;
};
export type BillingPage = {
  calls: BillingCall[];
  total: number;
  costUsd: number;
  unavailable: number;
  running: number;
};

type CallRow = {
  data: string;
  attempt_id: string | null;
  phase: CallDetails["phase"];
  status: CallDetails["status"];
  cost_usd: number | null;
};

function readCall(row: CallRow): CallDetails {
  const data = JSON.parse(row.data) as CallDetails;
  data.attemptId = row.attempt_id ?? undefined;
  data.phase = row.phase;
  data.status = row.status;
  if (row.cost_usd !== null) {
    data.usage ??= {};
    data.usage.costUsd = row.cost_usd;
  }
  return data;
}

export class Billing {
  persistence?: Persistence;
  constructor(private db: Database.Database) {}
  observe(
    cellId: string,
    attemptId?: string,
    selection?: { model: string; effort: string },
  ): CallObserver {
    return (phase) => {
      const id = token(),
        started = Date.now();
      const links = this.db
        .prepare("SELECT generation_id,judgment_id FROM cells WHERE id=?")
        .get(cellId) as
        | { generation_id: string | null; judgment_id: string | null }
        | undefined;
      const taskId =
        phase === "judge" ? links?.judgment_id : links?.generation_id;
      if (!taskId) throw new Error("Inference call requires a workflow task");
      let data: CallDetails = {
        phase,
        status: "running",
        attemptId,
        ...selection,
      };
      const save = () => {
        const { attemptId, phase, status, ...details } = data;
        const costUsd = data.usage?.costUsd;
        if (costUsd !== undefined)
          details.usage = { ...data.usage, costUsd: undefined };
        const json = JSON.stringify(details);
        const write = () => {
          this.db
            .prepare(
              `INSERT INTO inference_calls
                (id,cell_id,task_id,started_at,data,attempt_id,phase,status,cost_usd)
              VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                data=excluded.data,attempt_id=excluded.attempt_id,
                phase=excluded.phase,status=excluded.status,cost_usd=excluded.cost_usd`,
            )
            .run(
              id,
              cellId,
              taskId,
              started,
              json,
              attemptId ?? null,
              phase,
              status,
              costUsd ?? null,
            );
        };
        if (this.persistence) this.persistence.submit(write);
        else write();
      };
      save();
      return {
        update: (details) => {
          data = { ...data, ...details };
          save();
        },
        complete: (completion, usage) => {
          const error = completionFailure(completion.finishReason);
          data = {
            ...data,
            completion,
            usage,
            finishedAt: Date.now(),
            status: error ? "failed" : "succeeded",
            error,
          };
          save();
        },
        fail: (error, cancelled) => {
          if (data.status === "succeeded") return;
          const failure = failureDetails(error);
          data = {
            ...data,
            finishedAt: Date.now(),
            status: cancelled ? "cancelled" : "failed",
            error: cancelled ? undefined : failure.message,
            errorCode: cancelled ? undefined : failure.code,
            diagnostics: cancelled ? undefined : failureDiagnostics(error),
          };
          save();
        },
      };
    };
  }
  task(
    taskId: string,
    attemptId?: string,
  ): { usage?: Cell["usage"] } | undefined {
    if (attemptId) {
      const rows = this.db
        .prepare(
          "SELECT data,attempt_id,phase,status,cost_usd FROM inference_calls WHERE task_id=? AND attempt_id=? ORDER BY started_at, rowid",
        )
        .all(taskId, attemptId) as CallRow[];
      return rows.length
        ? {
            usage: sumUsage(rows.map((row) => readCall(row).usage)),
          }
        : undefined;
    }
    const row = this.db
      .prepare(
        `
      SELECT data,attempt_id,phase,status,cost_usd FROM inference_calls WHERE task_id=?
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `,
      )
      .get(taskId) as CallRow | undefined;
    return row ? { usage: readCall(row).usage } : undefined;
  }
  gridSpent(gridId: string, cells: readonly Cell[]): number {
    const rows = this.db
      .prepare(
        `SELECT t.id,t.status, COALESCE(SUM(b.cost_usd),0) costUsd,
        (SELECT latest.cost_usd FROM inference_calls latest
          WHERE latest.task_id=t.id AND latest.phase!='judge'
          ORDER BY latest.started_at DESC,latest.rowid DESC LIMIT 1) latestCostUsd
        FROM workflow_tasks t LEFT JOIN inference_calls b ON b.task_id=t.id
          AND b.phase!='judge'
        WHERE t.grid_id=? AND t.kind='generation' GROUP BY t.id`,
      )
      .all(gridId) as {
      id: string;
      status: string;
      costUsd: number;
      latestCostUsd: number | null;
    }[];
    const estimates = new Map<string, number>();
    for (const cell of cells) {
      if (cell.status !== "running" || !cell.generationId) continue;
      estimates.set(
        cell.generationId,
        Math.max(
          estimates.get(cell.generationId) ?? 0,
          cell.currentCallCostUsd ?? cell.estimatedUsage?.costUsd ?? 0,
        ),
      );
    }
    return rows.reduce(
      (sum, row) =>
        sum +
        row.costUsd +
        // A reported charge can arrive before the running task settles.
        (row.status === "running" && row.latestCostUsd === null
          ? (estimates.get(row.id) ?? 0)
          : 0),
      0,
    );
  }
  page(owner: string, offset: number, userId?: string): BillingPage {
    const join = `FROM inference_calls b JOIN cells c ON c.id=b.cell_id
      JOIN grids g ON g.id=c.grid_id WHERE ${userId ? "g.owner_user_id=?" : "g.owner=? AND g.owner_user_id IS NULL"}`;
    const summary = this.db
      .prepare(
        `SELECT COUNT(*) total,
      COALESCE(SUM(b.cost_usd),0) costUsd,
      COUNT(*)-COUNT(b.cost_usd) unavailable,
      SUM(b.status='running') running ${join}`,
      )
      .get(userId ?? owner) as Omit<BillingPage, "calls">;
    const rows = this.db
      .prepare(
        `SELECT b.id,b.started_at,b.data,b.attempt_id,b.phase,b.status,b.cost_usd,c.grid_id,c.position,
      g.data grid_data ${join} ORDER BY b.started_at DESC,b.rowid DESC LIMIT 50 OFFSET ?`,
      )
      .all(userId ?? owner, offset) as (CallRow & {
      id: string;
      started_at: number;
      grid_id: string;
      position: number;
      grid_data: string;
    })[];
    return {
      ...summary,
      running: summary.running ?? 0,
      calls: rows.map((row) => {
        const {
          completion: _completion,
          diagnostics: _diagnostics,
          attemptId: _attemptId,
          ...details
        } = readCall(row);
        const grid = JSON.parse(row.grid_data);
        const cell = expandGrid(grid.input)[row.position];
        return {
          ...details,
          id: row.id,
          startedAt: row.started_at,
          gridId: row.grid_id,
          gridPrompt: grid.input.prompt,
          model: details.model ?? cell.model,
          effort: details.effort ?? cell.effort,
        };
      }),
    };
  }
  recover() {
    this.db
      .prepare(
        `UPDATE inference_calls SET status='interrupted',
          data=json_set(data,'$.finishedAt',?)
      WHERE status='running'`,
      )
      .run(Date.now());
  }
}
