import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useConnection } from "../queries";
import { useTheme } from "../theme";
import { Connection } from "../components/connection";
import { ErrorMessage } from "../components/error-message";
export function Settings() {
  const { theme, setTheme } = useTheme();
  const cache = useQueryClient(),
    session = useConnection(),
    [error, setError] = useState("");
  async function disconnect() {
    try {
      await api("/session/key", "DELETE");
      await cache.invalidateQueries({ queryKey: ["session"] });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <main className="settings-page">
      <h1>Settings</h1>
      <section aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">Appearance</h2>
        <label className="theme-control">
          Theme
          <select
            value={theme}
            onChange={(event) =>
              setTheme(event.target.value as "system" | "light" | "dark")
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
      </section>
      <section>
        <h2>Inference</h2>
        <Connection returnTo="/settings" />
        {session.data?.connected && (
          <button className="secondary" onClick={disconnect}>
            Disconnect OpenRouter
          </button>
        )}
        <p className="hint">
          Generation uses your OpenRouter account and credits.
        </p>
        {new URLSearchParams(location.search).get("connection") ===
          "failed" && (
          <ErrorMessage error="OpenRouter connection failed. Connect again." />
        )}
        <ErrorMessage error={error} />
      </section>
    </main>
  );
}
