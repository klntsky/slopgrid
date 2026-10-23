import { useMutation } from "@tanstack/react-query";
import { api } from "../api";
import { useSession } from "../queries";
import { IdentityLink } from "./identity";
import { ErrorMessage } from "./feedback-message";

export function Account({
  returnTo,
  settings = false,
}: {
  returnTo: string;
  settings?: boolean;
}) {
  const session = useSession();
  const logout = useMutation({
    mutationFn: () => api("/auth/logout", "POST"),
    // Reload tears down private streams and clears all cached account data.
    onSuccess: () => location.assign("/settings"),
  });
  return (
    <div className="account-control">
      {session.isPending ? (
        <span role="status">Loading account…</span>
      ) : session.isError ? (
        <button className="secondary" onClick={() => void session.refetch()}>
          Retry account
        </button>
      ) : session.data.user ? (
        <>
          <IdentityLink identity={session.data.user} />
          {settings && (
            <button
              className="secondary"
              disabled={logout.isPending}
              onClick={() => logout.mutate()}
            >
              Sign out
            </button>
          )}
        </>
      ) : session.data.signInEnabled ? (
        <a
          className="button account-signin"
          href={`/api/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`}
        >
          <img
            className="github-signin-logo"
            src="/github-invertocat-white.svg"
            alt=""
          />
          Sign in with GitHub
        </a>
      ) : null}
      <ErrorMessage>
        {settings
          ? logout.error?.message
          : new URLSearchParams(location.search).get("signin") === "failed"
            ? "GitHub sign-in failed. Sign in again."
            : undefined}
      </ErrorMessage>
    </div>
  );
}
