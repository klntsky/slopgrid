import { useState } from "react";
import { setOpenRouterKey } from "../openrouter-key";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { api } from "../api";
import { useConnection } from "../queries";
import { ErrorMessage } from "./feedback-message";

export function Connection({
  returnTo,
  settings = false,
}: {
  returnTo: string;
  settings?: boolean;
}) {
  const session = useConnection(),
    cache = useQueryClient();
  const [editing, setEditing] = useState(false),
    [enteredKey, setEnteredKey] = useState("");
  const connectKey = useMutation({
    mutationFn: async () => {
      const key = enteredKey.trim();
      await api("/auth/key", "POST", undefined, key);
      setOpenRouterKey(key);
      setEnteredKey("");
      setEditing(false);
    },
  });
  const disconnect = useMutation({
    mutationFn: () => {
      setOpenRouterKey("");
      return api("/session/key", "DELETE");
    },
    onSuccess: () => cache.invalidateQueries({ queryKey: ["session"] }),
  });
  const checking = session.isPending || (session.isError && session.isFetching),
    connected = session.data?.connected === true,
    status = disconnect.isPending
      ? "Disconnecting…"
      : checking
        ? "Checking connection…"
        : session.isError
          ? "Could not check connection"
          : connected
            ? "Connected"
            : "Not connected";
  const authURL = `/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`;
  return (
    <>
      <div className="connection">
        <div className="connection-identity">
          <img className="openrouter-icon" src="/openrouter.svg" alt="" />
          <div>
            <strong>OpenRouter</strong>
            <span role="status" className="connection-state">
              {(checking || disconnect.isPending) && (
                <LoaderCircle className="spinner" aria-hidden="true" />
              )}
              {status}
            </span>
          </div>
        </div>
        <div className="connection-actions">
          {session.isError ? (
            <button
              className="secondary"
              disabled={session.isFetching}
              onClick={() => void session.refetch()}
            >
              Check again
            </button>
          ) : (
            !checking &&
            (!connected ? (
              <a
                className="button secondary"
                href={authURL}
                aria-label="Connect OpenRouter"
                onClick={() => setOpenRouterKey("")}
              >
                Connect
              </a>
            ) : settings ? (
              <>
                <button
                  className="secondary"
                  aria-label="Disconnect OpenRouter"
                  disabled={disconnect.isPending}
                  onClick={() => disconnect.mutate()}
                >
                  Disconnect
                </button>
                <a
                  className="connection-change"
                  href={authURL}
                  aria-label="Change OpenRouter connection"
                  aria-disabled={disconnect.isPending}
                  onClick={(event) => {
                    if (disconnect.isPending) event.preventDefault();
                    else setOpenRouterKey("");
                  }}
                >
                  Change connection
                </a>
              </>
            ) : (
              <Link to="/settings">Settings</Link>
            ))
          )}
          {!checking && !editing && (
            <button
              className="secondary"
              disabled={disconnect.isPending}
              onClick={() => {
                connectKey.reset();
                setEditing(true);
              }}
            >
              Use API key
            </button>
          )}
        </div>
        {editing && (
          <form
            className="connection-key-form"
            onSubmit={(event) => {
              event.preventDefault();
              connectKey.mutate();
            }}
          >
            <label htmlFor="openrouter-api-key">API key</label>
            <input
              id="openrouter-api-key"
              type="password"
              autoComplete="off"
              value={enteredKey}
              onChange={(event) => setEnteredKey(event.target.value)}
              autoFocus
            />
            <div className="connection-actions">
              <button
                className="secondary"
                type="submit"
                aria-label="Connect API key"
                disabled={!enteredKey.trim() || connectKey.isPending}
              >
                {connectKey.isPending ? "Connecting…" : "Connect"}
              </button>
              <button
                className="secondary"
                type="button"
                disabled={connectKey.isPending}
                onClick={() => {
                  setEnteredKey("");
                  setEditing(false);
                  connectKey.reset();
                }}
              >
                Cancel
              </button>
            </div>
            <ErrorMessage>{connectKey.error?.message}</ErrorMessage>
          </form>
        )}
      </div>
      <ErrorMessage>{disconnect.error?.message}</ErrorMessage>
      {new URLSearchParams(location.search).get("connection") === "failed" && (
        <ErrorMessage>
          OpenRouter connection failed. Connect again.
        </ErrorMessage>
      )}
    </>
  );
}
