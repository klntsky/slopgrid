import { useTheme } from "../theme";
import { Connection } from "../components/connection";
export function Settings() {
  const { theme, setTheme } = useTheme();
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
        <Connection returnTo="/settings" settings />
        <p className="hint">
          Generation uses your OpenRouter account and credits.
        </p>
      </section>
    </main>
  );
}
