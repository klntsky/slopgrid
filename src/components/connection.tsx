import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { api, queries, storage, useSession } from "../api";
import { ErrorMessage, Modal } from "./ui";

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
    <section aria-label="Inference provider setup">
      <h2>Inference provider setup</h2>
      <div className="connection">
        <img src="/openrouter.svg" alt="OpenRouter" width="24" />
        <span>
          {isPending
            ? "Checking connection"
            : session?.connected
              ? "Connected"
              : "Not connected"}
        </span>
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
            aria-label="Connect OpenRouter"
            href={`/api/auth/start?returnTo=${encodeURIComponent(location.pathname)}`}
          >
            Connect
          </a>
        )}
        {session?.connected && settings && (
          <a href="/api/auth/start?returnTo=%2Fsettings">Change connection</a>
        )}
        {(!session?.connected || settings) && (
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
        {checkError && (
          <button type="button" onClick={() => refetch()}>
            Retry connection check
          </button>
        )}
      </div>
      <ErrorMessage error={checkError} />
      {new URLSearchParams(location.search).get("connection") === "failed" && (
        <ErrorMessage error="OpenRouter connection failed. Connect again." />
      )}
      {manual && (
        <Modal
          title="OpenRouter API key"
          busy={busy}
          close={() => setManual(false)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void connect();
            }}
          >
            <label>
              API key
              <input
                aria-label="API key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            <button disabled={busy}>Connect API key</button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setManual(false)}
            >
              Cancel
            </button>
            <ErrorMessage error={error} />
          </form>
        </Modal>
      )}
      {!manual && <ErrorMessage error={error} />}
    </section>
  );
}
