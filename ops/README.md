# Slopgrid operations

Slopgrid operations builds, validates, and deploys committed Slopgrid releases
through one command. It owns the complete deployment implementation, including
remote installation, engine draining, backups, process startup, and final status.

After configuring the ignored application-root `.env` as described in
[DEVELOPMENT.md](DEVELOPMENT.md), run these commands from `ops/`:
`./deploy.sh validate` for an isolated committed worktree candidate, or explicitly
promote the authoritative master tip with `./deploy.sh production`.
From an application worktree, both default to that worktree's current commit;
otherwise they use the configured application checkout. Validation uses per-run
workspaces, not a shared staging runtime. Select affected tests for `validate`;
use `--skip-tests` only for deliberate deployment test skips.
`./deploy.sh --help` lists the options.

Production requires `OPS_MASTER_REPOSITORY` private configuration and live Git read
access on both machines, and never deploys staging. It promotes only its single
configured runtime. Automatic mode preserves a compatible running engine. Logs
and deployment records survive a disconnected terminal. Infrastructure values and
credentials stay in ignored local configuration, not tracked source.
