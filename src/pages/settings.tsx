import { Account } from "../components/account";
import { useTheme } from "../theme";
import { Connection } from "../components/connection";
export function Settings() {
  const { theme, setTheme } = useTheme();
  return (
    <main className="settings-page">
      <div className="page-title">
        <h1>Settings</h1>
      </div>
      <section aria-labelledby="account-heading">
        <h2 id="account-heading">Account</h2>
        <Account returnTo="/settings" settings />
      </section>
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
          More providers coming in the future. For now, use the bring-your-own-key
          feature on OpenRouter to get inference without paying OpenRouter's
          markup
        </p>
      </section>
    </main>
  );
}
