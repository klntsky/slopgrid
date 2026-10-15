import { useState } from "react";
import { api, useSession } from "../api";
import { ErrorMessage } from "./ui";

export function Account({ settings = false }: { settings?: boolean }) {
  const session = useSession();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<unknown>();
  const user = session.data?.user;
  async function logout() {
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/auth/logout", {});
      // Reload tears down private streams and discards cached account data.
      location.assign("/settings");
    } catch (error) {
      setError(error);
      setBusy(false);
    }
  }
  return (
    <div className="account-control">
      {session.isPending ? (
        <span role="status">Loading account...</span>
      ) : session.isError ? (
        <button disabled={session.isFetching} onClick={() => session.refetch()}>
          Retry account
        </button>
      ) : user ? (
        <>
          <a href={user.profileURL}>
            <img
              className="github-icon"
              src="/github-invertocat-white.svg"
              alt="GitHub"
            />
            {user.username}
          </a>
          {settings && (
            <button disabled={busy} onClick={logout}>
              Sign out
            </button>
          )}
        </>
      ) : (
        <a
          className="button account-signin"
          aria-label="Sign in with GitHub"
          href={`/api/auth/github/start?returnTo=${encodeURIComponent(location.pathname)}`}
        >
          <img
            className="github-icon"
            src="/github-invertocat-white.svg"
            alt=""
          />
          Sign in with GitHub
        </a>
      )}
      <ErrorMessage error={error} />
    </div>
  );
}
