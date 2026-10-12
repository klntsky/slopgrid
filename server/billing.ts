import type Database from "better-sqlite3";
import type { Cell, Completion } from "./domain.js";
import { expandGrid } from "./domain.js";
import { token } from "./ids.js";
import { completionFailure, failureDetails } from "./failures.js";

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

export class Billing {
  constructor(private db: Database.Database) {}
  observe(cellId: string): CallObserver {
    return (phase) => {
      const id = token(),
        started = Date.now();
      let data: CallDetails = { phase, status: "running" };
      const save = () =>
        this.db
          .prepare("UPDATE inference_calls SET data=? WHERE id=?")
          .run(JSON.stringify(data), id);
      this.db
        .prepare(
          "INSERT INTO inference_calls (id, cell_id, started_at, data) VALUES (?,?,?,?)",
        )
        .run(id, cellId, started, JSON.stringify(data));
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
          };
          save();
        },
      };
    };
  }
  cell(cellId: string): { usage?: Cell["usage"] } | undefined {
    const row = this.db
      .prepare(
        `
      SELECT data FROM inference_calls WHERE cell_id=?
      ORDER BY started_at DESC, rowid DESC LIMIT 1
    `,
      )
      .get(cellId) as { data: string } | undefined;
    return row
      ? { usage: (JSON.parse(row.data) as CallDetails).usage }
      : undefined;
  }
  gridSpent(gridId: string, cells: readonly Cell[]): number {
    const rows = this.db
      .prepare(
        `SELECT c.id, COALESCE(SUM(json_extract(b.data,'$.usage.costUsd')),0) costUsd,
        (SELECT json_extract(latest.data,'$.usage.costUsd') FROM inference_calls latest
          WHERE latest.cell_id=c.id ORDER BY latest.started_at DESC,latest.rowid DESC LIMIT 1) latestCostUsd
        FROM cells c LEFT JOIN inference_calls b ON b.cell_id=c.id
        WHERE c.grid_id=? GROUP BY c.id`,
      )
      .all(gridId) as {
      id: string;
      costUsd: number;
      latestCostUsd: number | null;
    }[];
    const estimates = new Map(
      cells
        .filter((cell) => cell.status === "running")
        .map((cell) => [cell.id, cell.estimatedCostUsd ?? 0]),
    );
    return rows.reduce(
      (sum, row) =>
        sum + row.costUsd +
        // A reported charge can arrive before the running cell settles.
        (row.latestCostUsd === null ? estimates.get(row.id) ?? 0 : 0),
      0,
    );
  }
  page(owner: string, offset: number, userId?: string): BillingPage {
    const join = `FROM inference_calls b JOIN cells c ON c.id=b.cell_id
      JOIN grids g ON g.id=c.grid_id WHERE ${userId ? "json_extract(g.data,'$.ownerUserId')=?" : "json_extract(g.data,'$.owner')=? AND json_extract(g.data,'$.ownerUserId') IS NULL"}`;
    const summary = this.db
      .prepare(
        `SELECT COUNT(*) total,
      COALESCE(SUM(json_extract(b.data,'$.usage.costUsd')),0) costUsd,
      COUNT(*)-COUNT(json_extract(b.data,'$.usage.costUsd')) unavailable,
      SUM(json_extract(b.data,'$.status')='running') running ${join}`,
      )
      .get(userId ?? owner) as Omit<BillingPage, "calls">;
    const rows = this.db
      .prepare(
        `SELECT b.id,b.started_at,b.data,c.grid_id,c.position,
      g.data grid_data ${join} ORDER BY b.started_at DESC,b.rowid DESC LIMIT 50 OFFSET ?`,
      )
      .all(userId ?? owner, offset) as {
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
        const grid = JSON.parse(row.grid_data);
        const cell = expandGrid(grid.input)[row.position];
        return {
          ...details,
          id: row.id,
          startedAt: row.started_at,
          gridId: row.grid_id,
          gridPrompt: grid.input.prompt,
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
