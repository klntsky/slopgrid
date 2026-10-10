import { useConnection } from "../queries";
export function Connection({ returnTo }: { returnTo: string }) {
  const session = useConnection();
  return (
    <div className="connection">
      <div>
        <strong>OpenRouter</strong>
        <p>
          {session.data?.connected
            ? "OpenRouter connected"
            : "Connect OpenRouter to generate with your account."}
        </p>
      </div>
      <a
        className="button secondary"
        href={`/api/auth/start?returnTo=${encodeURIComponent(returnTo)}`}
      >
        <img className="openrouter-icon" src="/openrouter.svg" alt="" />
        {session.data?.connected
          ? "Reconnect OpenRouter"
          : "Connect OpenRouter"}
      </a>
    </div>
  );
}
