import type { Identity } from "../../server/domain";

export function IdentityLink({ identity }: { identity: Identity }) {
  return (
    <a className="identity-link" href={identity.profileURL}>
      {identity.provider === "github" && (
        <svg viewBox="0 0 24 24" aria-hidden="true" className="github-icon">
          <path
            fill="currentColor"
            d="M12 .75a11.25 11.25 0 0 0-3.558 21.924c.563.104.768-.244.768-.542 0-.267-.01-.975-.015-1.914-3.13.68-3.79-1.51-3.79-1.51-.512-1.3-1.25-1.646-1.25-1.646-1.022-.698.077-.684.077-.684 1.13.08 1.725 1.16 1.725 1.16 1.004 1.72 2.634 1.223 3.275.935.102-.727.393-1.223.715-1.504-2.499-.284-5.127-1.25-5.127-5.564 0-1.229.44-2.234 1.16-3.02-.116-.284-.503-1.429.11-2.979 0 0 .945-.302 3.094 1.154A10.8 10.8 0 0 1 12 6.18c.956.004 1.92.129 2.82.38 2.148-1.456 3.092-1.154 3.092-1.154.614 1.55.227 2.695.111 2.978.722.787 1.16 1.792 1.16 3.021 0 4.326-2.632 5.277-5.14 5.556.404.349.765 1.04.765 2.097 0 1.514-.014 2.735-.014 3.106 0 .3.203.65.774.54A11.25 11.25 0 0 0 12 .75Z"
          />
        </svg>
      )}
      <span>{identity.username}</span>
    </a>
  );
}
export function Author({ identity }: { identity: Identity | null }) {
  return (
    <span className="grid-author">
      by {identity ? <IdentityLink identity={identity} /> : "Anonymous"}
    </span>
  );
}
