import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { api, queries, storage, useSession } from "../api";
import { ErrorMessage } from "./ui";

export function Connection({ settings = false }: { settings?: boolean }) {
  const { data: session, isPending, error: checkError, refetch } = useSession();
  const [key, setKey] = useState(""),
    [manual, setManual] = useState(false),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  async function connect() {
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch("/api/auth/key", {
        method: "POST",
        headers: { Authorization: `Bearer ${key.trim()}` },
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      storage.set("slopgrid-openrouter-key", key.trim());
      setKey("");
      setManual(false);
      await queries.invalidateQueries({ queryKey: ["session"] });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="provider" aria-label="Inference provider setup">
      {settings && <h2>Inference</h2>}
      <div className="connection">
        <div className="connection-identity">
        <img className="openrouter-icon" src="/openrouter.svg" alt="" width="24" />
        <div><strong>OpenRouter</strong>
        <span className="connection-state">
          {isPending
            ? "Checking connection"
            : session?.connected
              ? "Connected"
              : "Not connected"}
        </span>
        </div></div>
        <div className="connection-actions">
        {session?.connected && !settings ? (
          <Link to="/settings">Settings</Link>
        ) : session?.connected ? (
          <button
            type="button"
            aria-label="Disconnect OpenRouter"
            onClick={async () => {
              try {
                await api("/api/session/key", undefined, "DELETE");
                storage.remove("slopgrid-openrouter-key");
                await queries.invalidateQueries({ queryKey: ["session"] });
              } catch (e) {
                setError(e);
              }
            }}
          >
            Disconnect
          </button>
        ) : (
          <a
            className="button secondary"
            aria-label="Connect OpenRouter"
            href={`/api/auth/start?returnTo=${encodeURIComponent(location.pathname)}`}
          >
            Connect
          </a>
        )}
        {session?.connected && settings && (
          <a href="/api/auth/start?returnTo=%2Fsettings">Change connection</a>
        )}
        {!manual && (
          <button
            type="button"
            onClick={() => {
              setError(undefined);
              setManual(true);
            }}
          >
            Use API key
          </button>
        )}
        </div>
        {checkError && (
          <button type="button" onClick={() => refetch()}>
            Retry connection check
          </button>
        )}
      {manual && (
          <div className="connection-key-form"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (key.trim() && !busy) void connect();
              }
            }}
          >
            <label>
              API key
              <input
                aria-label="API key"
                type="password"
                autoFocus
                autoComplete="off"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <div className="connection-actions">
            <button type="button" aria-label="Connect API key" disabled={busy || !key.trim()} onClick={() => void connect()}>Connect</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => { setManual(false); setKey(""); setError(undefined); }}
            >
              Cancel
            </button>
            </div>
            <ErrorMessage error={error} />
          </div>
      )}
      </div>
      <ErrorMessage error={checkError} />
      {new URLSearchParams(location.search).get("connection") === "failed" && (
        <ErrorMessage error="OpenRouter connection failed. Connect again." />
      )}
      {!manual && <ErrorMessage error={error} />}
    </div>
  );
}
