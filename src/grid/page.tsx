import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useParams, useNavigate } from "@tanstack/react-router";
import { Square, Play, Pencil, Share, GitBranch } from "lucide-react";
import { api, type GridView, storage, money, queries } from "../api";
import {
  CopyButton,
  ErrorMessage,
  Hint,
  IconButton,
  Modal,
} from "../components/ui";
import { Author } from "../pages";
import { saveDraft } from "../create/draft";
import { useGrid } from "./live";
import { Workspace } from "./workspace";

function Publish({
  grid,
  close,
  accept,
}: {
  grid: GridView;
  close: () => void;
  accept: (grid: GridView) => void;
}) {
  const [visibility, setVisibility] = useState(grid.visibility),
    [confirm, setConfirm] = useState(false),
    [remember, setRemember] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  async function save() {
    setBusy(true);
    try {
      const result = await api<GridView>(`/api/grids/${grid.id}/publish`, {
        visibility,
      });
      accept(result);
      if (remember) storage.set("slopgrid-skip-publish-confirmation", true);
      await queries.invalidateQueries({ queryKey: ["grids"] });
      close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={confirm ? "Confirm publishing" : "Control who can see this grid"}
      close={() => (confirm ? setConfirm(false) : close())}
      closeButton={false}
      busy={busy}
    >
      {confirm ? (
        <>
          <p>
            This projects aims to facilitate model benchmarking and research,
            and we don't want valuable data to disappear. For this reason,
            making a published grid private is impossible.
          </p>
          <label>
            <input
              type="checkbox"
              disabled={busy}
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Don’t ask again
          </label>
          <button autoFocus className="primary" disabled={busy} onClick={save}>
            Confirm
          </button>
        </>
      ) : (
        <>
          {(["private", "unlisted", "public"] as const).map((v, i) =>
            grid.published && v === "private" ? null : (
              <label key={v}>
                <input
                  type="radio"
                  autoFocus={v === grid.visibility}
                  name="visibility"
                  value={v}
                  checked={visibility === v}
                  disabled={
                    busy ||
                    (grid.published && v === "private") ||
                    (grid.visibility === "public" && v !== "public")
                  }
                  onChange={() => setVisibility(v)}
                />
                {["Keep private", "Accessible by link", "Listed publicly"][i]}
              </label>
            ),
          )}
          <button
            className="primary"
            disabled={busy}
            onClick={() => {
              if (visibility === "private") close();
              else if (
                !grid.published &&
                !storage.get("slopgrid-skip-publish-confirmation", false)
              )
                setConfirm(true);
              else void save();
            }}
          >
            Save
          </button>
        </>
      )}
      <button
        disabled={busy}
        onClick={() => (confirm ? setConfirm(false) : close())}
      >
        Cancel
      </button>
      <ErrorMessage error={error} />
    </Modal>
  );
}
export function GridPage() {
  const titleButton = useRef<HTMLButtonElement>(null);
  const titleCancelled = useRef(false);
  const titleSaving = useRef(false);
  const { id } = useParams({ strict: false }) as { id: string };
  const { grid, error, disconnected, accept } = useGrid(id);
  const [actionError, setActionError] = useState<unknown>(),
    [publish, setPublish] = useState(false),
    [editingTitle, setEditingTitle] = useState(false),
    [title, setTitle] = useState(""),
    [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [interrupted, setInterrupted] = useState(false);
  useEffect(() => {
    setInterrupted(
      grid?.interruption === "billing" && grid.status === "paused",
    );
  }, [grid?.interruption, grid?.status]);
  async function command(action: string) {
    setBusy(true);
    setActionError(undefined);
    try {
      const next = await api<GridView>(`/api/grids/${id}/${action}`, {});
      accept(next);
      return next;
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(false);
    }
  }
  async function edit() {
    if (!grid) return;
    const source = grid.published ? grid : await command("edit");
    if (!source) return;
    saveDraft({
      ...source.input,
      parallelWorkers: undefined,
      sourceGridId: id,
      reuseArtifacts: true,
    });
    await navigate({ to: "/" });
  }
  async function saveTitle(value: string) {
    if (titleCancelled.current || titleSaving.current) return;
    titleSaving.current = true;
    try {
      accept(
        await api<GridView>(
          `/api/grids/${id}/title`,
          { title: value },
          "PATCH",
        ),
      );
      setEditingTitle(false);
    } catch (e) {
      setActionError(e);
    } finally {
      titleSaving.current = false;
    }
  }
  if (error && !grid)
    return (
      <main className="page">
        <ErrorMessage error={error} />
      </main>
    );
  if (!grid) return <div className="spinner" aria-label="Loading grid" />;
  const finished = grid.cells.filter(
    (c) => c.status === "complete" || c.status === "error",
  ).length;
  const failed = grid.cells.filter((c) => c.status === "error").length;
  const progressText = failed
    ? `${finished} of ${grid.cells.length} outputs finished: ${finished - failed} complete, ${failed} failed`
    : `${finished} of ${grid.cells.length} outputs complete`;
  const cost = grid.cells.reduce(
    (sum, c) =>
      sum +
      (c.status === "complete"
        ? (c.usage?.costUsd ?? 0)
        : c.status === "running"
          ? (c.estimatedUsage?.costUsd ?? 0)
          : 0),
    0,
  );
  const target = document.getElementById("grid-navigation");
  const approximate = grid.cells.some(
    (cell) => cell.status === "running" && cell.estimatedUsage,
  )
    ? "≈"
    : "";
  return (
    <>
      {target &&
        createPortal(
          <>
            <div className="grid-run-action">
              {grid.canEdit &&
                !grid.published &&
                grid.cells.some((c) => c.status !== "complete") && (
                  <Hint
                    text={
                      grid.status === "running"
                        ? "Work can be resumed later, unfinished responses will be lost"
                        : undefined
                    }
                  >
                    <button
                      className="icon-button"
                      aria-label={
                        grid.status === "running"
                          ? "Pause generation"
                          : "Resume generation"
                      }
                      disabled={busy}
                      onClick={() =>
                        command(grid.status === "running" ? "pause" : "retry")
                      }
                    >
                      {grid.status === "running" ? (
                        <Square className="stop" />
                      ) : (
                        <Play />
                      )}
                    </button>
                  </Hint>
                )}
            </div>
            <div className="grid-information">
              <div className="title-prompt">
                {editingTitle ? (
                  <input
                    aria-label="Grid title"
                    maxLength={40}
                    defaultValue={title}
                    onFocus={(e) => e.currentTarget.select()}
                    onBlur={(e) => void saveTitle(e.currentTarget.value)}
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        titleCancelled.current = true;
                        setEditingTitle(false);
                        requestAnimationFrame(() =>
                          titleButton.current?.focus(),
                        );
                      }
                    }}
                  />
                ) : grid.canEdit ? (
                  <button
                    ref={titleButton}
                    className="grid-title"
                    aria-label={grid.title ? "Edit title" : "Set Title"}
                    disabled={!grid.canEdit}
                    onClick={() => {
                      titleCancelled.current = false;
                      setTitle(grid.title ?? "");
                      setEditingTitle(true);
                    }}
                  >
                    {grid.title || "Set Title"}
                  </button>
                ) : grid.title ? (
                  <span className="grid-name">{grid.title || "Set Title"}</span>
                ) : null}
                {(grid.canEdit || grid.title) && (
                  <span className="grid-title-dot">·</span>
                )}
                <Hint text={grid.input.prompt} theme="grid-prompt" overflowOnly>
                  <h1 tabIndex={0} className="grid-prompt">
                    {grid.input.prompt}
                  </h1>
                </Hint>
                <CopyButton value={grid.input.prompt} label="Copy prompt" />
              </div>
              <div className="grid-byline">
                <Author author={grid.author} />
                <span>·</span>
                <Hint text="Inference costs for this grid, not including failed attempts">
                  <span
                    aria-label={`Total cost: ${approximate}$${money(cost)}`}
                    className={`grid-cost ${grid.live ? "running-cost" : ""}`}
                  >
                    cost {approximate}${money(cost)}
                  </span>
                </Hint>
                {grid.canEdit && (
                  <>
                    <span>·</span>
                    <Hint text="Inference costs for this grid, including failed attempts - how much you have actually spent on this page">
                      <span
                        className={`grid-spent ${grid.live ? "running-cost" : ""}`}
                        aria-label={`Total spent: ${approximate}$${money(grid.spentUsd ?? 0)}`}
                      >
                        spent {approximate}${money(grid.spentUsd ?? 0)}
                      </span>
                    </Hint>
                  </>
                )}
              </div>
            </div>
            <div className="grid-actions">
              {(grid.canEdit || grid.published) && (
                <IconButton
                  tooltip
                  label={grid.published ? "FORK" : "EDIT"}
                  disabled={busy}
                  onClick={edit}
                >
                  {grid.published ? <GitBranch /> : <Pencil />}
                </IconButton>
              )}
              {grid.canEdit && grid.visibility !== "public" && (
                <IconButton
                  tooltip
                  label={grid.published ? "Change visibility" : "PUBLISH"}
                  disabled={finished !== grid.cells.length || busy}
                  onClick={() => setPublish(true)}
                >
                  <Share />
                </IconButton>
              )}
              {grid.published && (
                <CopyButton value={location.href} label="Copy link" />
              )}
            </div>
          </>,
          target,
        )}
      {target &&
        createPortal(
          <div className="progress-hint">
            <Hint text={progressText}>
              <div className="progress" tabIndex={0}>
                <progress
                  aria-valuetext={progressText}
                  aria-label="Grid generation"
                  value={finished}
                  max={grid.cells.length}
                />
                {grid.cells.map((c) => (
                  <span
                    key={c.id}
                    className="progress-segment"
                    data-status={c.status}
                    style={{ flex: 1 }}
                  />
                ))}
                {grid.status === "running" && (
                  <span className="progress-spark" />
                )}
              </div>
            </Hint>
          </div>,
          target,
        )}
      <Workspace key={id} grid={grid} />
      {disconnected && (
        <div className="connection-lost" role="status">
          <span className="spinner" />
          Connection lost. Reconnecting…
        </div>
      )}
      {actionError && (
        <Modal
          title="Inference interrupted"
          close={() => setActionError(undefined)}
        >
          <ErrorMessage error={actionError} />
        </Modal>
      )}
      {interrupted && !actionError && (
        <Modal
          title="Inference interrupted"
          close={() => setInterrupted(false)}
        >
          <a
            href="https://openrouter.ai/settings/credits"
            target="_blank"
            rel="noreferrer"
          >
            Top up
          </a>
          <button
            disabled={busy}
            onClick={async () => {
              setInterrupted(false);
              await command("retry");
            }}
          >
            Retry unfinished cells
          </button>
        </Modal>
      )}
      {publish && (
        <Publish grid={grid} close={() => setPublish(false)} accept={accept} />
      )}
    </>
  );
}
