import type Database from "better-sqlite3";
import type { Cell, Completion } from "./domain.js";
import { expandGrid } from "./domain.js";
import { token } from "./ids.js";
import { failureDetails } from "./failures.js";

export type CallDetails = {
  phase: Completion["phase"];
  status: "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  finishedAt?: number;
  generationId?: string;
  httpStatus?: number;
  completion?: Completion;
  usage?: Cell["usage"];
  error?: string;
  errorCode?: string | number;
};
export type CallRecorder = {
  update: (details: Partial<CallDetails>) => void;
  complete: (completion: Completion, usage: Cell["usage"]) => void;
  fail: (error: unknown, cancelled: boolean) => void;
};
export type CallObserver = (phase: Completion["phase"]) => CallRecorder;
export type BillingCall = Omit<CallDetails, "completion"> & {
  id: string;
  startedAt: number;
  gridId: string;
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

export class Billing {
  constructor(private db: Database.Database) {}
  observe(cellId: string): CallObserver {
    const attemptId = token();
    return (phase) => {
      const id = token(),
        started = Date.now();
      let data: CallDetails = { phase, status: "running" };
      const save = () =>
        this.db
          .prepare("UPDATE inference_calls SET data=? WHERE id=?")
          .run(JSON.stringify(data), id);
      this.db
        .prepare("INSERT INTO inference_calls VALUES (?,?,?,?,?)")
        .run(id, cellId, attemptId, started, JSON.stringify(data));
      return {
        update: (details) => {
          data = { ...data, ...details };
          save();
        },
        complete: (completion, usage) => {
          data = {
            ...data,
            completion,
            usage,
            finishedAt: Date.now(),
            status: completion.finishReason === "stop" ? "succeeded" : "failed",
            error:
              completion.finishReason === "stop"
                ? undefined
                : "The model did not complete its response. Retry generation.",
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
          };
          save();
        },
      };
    };
  }
  cell(
    cellId: string,
  ): { usage?: Cell["usage"]; completions?: Completion[] } | undefined {
    const rows = this.db
      .prepare(
        `
      SELECT data FROM inference_calls WHERE cell_id=? AND attempt_id=(
        SELECT attempt_id FROM inference_calls WHERE cell_id=?
        ORDER BY started_at DESC, rowid DESC LIMIT 1
      ) ORDER BY started_at, rowid`,
      )
      .all(cellId, cellId) as { data: string }[];
    if (!rows.length) return;
    const calls = rows.map((row) => JSON.parse(row.data) as CallDetails);
    const reported = calls.filter((call) => call.usage !== undefined);
    return {
      completions: calls.flatMap((call) =>
        call.completion ? [call.completion] : [],
      ),
      usage: reported.length
        ? {
            inputTokens: reported.reduce(
              (sum, c) => sum + (c.usage?.inputTokens ?? 0),
              0,
            ),
            outputTokens: reported.reduce(
              (sum, c) => sum + (c.usage?.outputTokens ?? 0),
              0,
            ),
            costUsd: calls.every((c) => c.usage?.costUsd !== undefined)
              ? calls.reduce((sum, c) => sum + c.usage!.costUsd!, 0)
              : undefined,
          }
        : undefined,
    };
  }
  page(owner: string, offset: number): BillingPage {
    const join = `FROM inference_calls b JOIN cells c ON c.id=b.cell_id
      JOIN grids g ON g.id=c.grid_id WHERE json_extract(g.data,'$.owner')=?`;
    const summary = this.db
      .prepare(
        `SELECT COUNT(*) total,
      COALESCE(SUM(json_extract(b.data,'$.usage.costUsd')),0) costUsd,
      COUNT(*)-COUNT(json_extract(b.data,'$.usage.costUsd')) unavailable,
      SUM(json_extract(b.data,'$.status')='running') running ${join}`,
      )
      .get(owner) as Omit<BillingPage, "calls">;
    const rows = this.db
      .prepare(
        `SELECT b.id,b.started_at,b.data,c.grid_id,c.position,
      g.data grid_data ${join} ORDER BY b.started_at DESC,b.rowid DESC LIMIT 50 OFFSET ?`,
      )
      .all(owner, offset) as {
      id: string;
      started_at: number;
      data: string;
      grid_id: string;
      position: number;
      grid_data: string;
    }[];
    return {
      ...summary,
      running: summary.running ?? 0,
      calls: rows.map((row) => {
        const { completion: _completion, ...details } = JSON.parse(
          row.data,
        ) as CallDetails;
        const cell = expandGrid(JSON.parse(row.grid_data).input)[row.position];
        return {
          ...details,
          id: row.id,
          startedAt: row.started_at,
          gridId: row.grid_id,
          model: cell.model,
          effort: cell.effort,
        };
      }),
    };
  }
  recover() {
    this.db
      .prepare(
        `UPDATE inference_calls SET data=json_set(data,
      '$.status','interrupted','$.finishedAt',?)
      WHERE json_extract(data,'$.status')='running'`,
      )
      .run(Date.now());
  }
}
