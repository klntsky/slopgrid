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
      let data: CallDetails = {
        phase,
        status: "running",
        attemptId,
        ...selection,
      };
      const save = () => {
        const json = JSON.stringify(data);
        const write = () => {
          this.db
            .prepare(
              `INSERT INTO inference_calls (id, cell_id, started_at, data)
            VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
            )
            .run(id, cellId, started, json);
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
  cell(
    cellId: string,
    attemptId?: string,
  ): { usage?: Cell["usage"] } | undefined {
    if (attemptId) {
      const rows = this.db
        .prepare(
          "SELECT data FROM inference_calls WHERE cell_id=? AND json_extract(data,'$.attemptId')=? AND COALESCE(json_extract(data,'$.phase'),'')!='judge' ORDER BY started_at, rowid",
        )
        .all(cellId, attemptId) as { data: string }[];
      return rows.length
        ? {
            usage: sumUsage(
              rows.map((row) => (JSON.parse(row.data) as CallDetails).usage),
            ),
          }
        : undefined;
    }
    const row = this.db
      .prepare(
        `
      SELECT data FROM inference_calls WHERE cell_id=? AND COALESCE(json_extract(data,'$.phase'),'')!='judge'
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
          WHERE latest.cell_id=c.id AND COALESCE(json_extract(latest.data,'$.phase'),'')!='judge'
          ORDER BY latest.started_at DESC,latest.rowid DESC LIMIT 1) latestCostUsd
        FROM cells c LEFT JOIN inference_calls b ON b.cell_id=c.id
          AND COALESCE(json_extract(b.data,'$.phase'),'')!='judge'
        WHERE c.grid_id=? GROUP BY c.id`,
      )
      .all(gridId) as {
      id: string;
      costUsd: number;
      latestCostUsd: number | null;
    }[];
    const estimates = new Map(
      cells
        .filter(
          (cell) =>
            cell.status === "running" &&
            (!cell.generationSourceId ||
              (cell.generationSourceId === cell.id &&
                cell.generationStatus === "running")),
        )
        .map((cell) => [
          cell.id,
          cell.currentCallCostUsd ?? cell.estimatedUsage?.costUsd ?? 0,
        ]),
    );
    return rows.reduce(
      (sum, row) =>
        sum +
        row.costUsd +
        // A reported charge can arrive before the running cell settles.
        (row.latestCostUsd === null ? (estimates.get(row.id) ?? 0) : 0),
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
        const {
          completion: _completion,
          diagnostics: _diagnostics,
          attemptId: _attemptId,
          ...details
        } = JSON.parse(row.data) as CallDetails;
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
        `UPDATE inference_calls SET data=json_set(data,
      '$.status','interrupted','$.finishedAt',?)
      WHERE json_extract(data,'$.status')='running'`,
      )
      .run(Date.now());
  }
}
