# Deployment architecture

## Command and transport

`ops/deploy.sh` invokes the Node command interface. It resolves the application
and operations commits, rejects uncommitted tracked changes, and uploads Git
archives over SSH. The ignored application-root `.env` supplies infrastructure
configuration; tracked files contain no deployed-instance settings. The tools
archive contains only the committed `ops/` subtree, installed into its own
immutable directory and compared on reuse. The application archive and tools
archive never contain the ignored root `.env`.

Each invocation gets a fresh run directory and executes in tmux with an atomic
exit status. Runtime deployments acquire the exclusive deployment lock; independent
`validate` runs do not. The local command streams the log and waits. The status
command reconnects using the exact implementation recorded for that run. A lost
worker is reported as failure rather than interpreted as a successful deployment.

Production eligibility is the resolved candidate commit's equality with the
authoritative `OPS_MASTER_REPOSITORY` `refs/heads/master` tip, queried live with Git.
The CLI checks before upload. The remote pipeline independently checks before
runtime operations, after validation, and just before production promotion.
Flags, branch names, cached refs, historical ancestry, and request-provided
master hashes do not grant eligibility. An unavailable authority fails closed.

## Build and validation boundaries

Each run builds its own committed source archive using the application's lockfile.
The build records its source archive checksum, source and frontend manifests,
engine fingerprint, and toolchain versions. Builds are not read from or adopted
from a shared staging runtime or mutable worktree. Existing deployed releases
are verified and never rewritten.

Validation runs in a separate run-owned source workspace with that run's frontend
build and read-only dependency link. A short temporary directory supplies isolated
SQLite/output paths, a generation socket and PM2 home. These override inherited
and private test settings; fixture servers use OS-assigned ports (`E2E_PORT=0`).
Production validation snapshots the live SQLite database through its online backup
API, then runs candidate storage initialization on the copy. Test service fixtures
receive independent copies of that migrated database; schema-specific unit fixtures
retain their own databases. Output artifacts and production runtime credentials
remain outside the validation boundary. Migration rehearsal is required even when
tests are explicitly skipped. Temporary runtime data is removed after success or
failure. The result explicitly records passed, failed, or skipped for this run,
not a historical status file.

`validate` never prepares or deploys a persistent runtime and can run concurrently
with other candidates or a production deployment. Production prepares and promotes
only its one configured runtime after isolated validation. Explicit staging
deployment is an administrative operation, not a common worktree testing or
promotion gate.

## Runtime lifecycle

The engine fingerprint bundles the engine entry point to discover transitive
source dependencies and includes package manifests and the lockfile. Combined
with the engine environment and Node executable, it selects soft or machinery
mode. Forced soft mode rejects incompatible changes before either target is
modified. An already active compatible release is left running.

Soft updates retain the engine, install frontend assets, and replace only the
web process. Machinery updates close admission and drain through the application's
control command, stop processes, back up SQLite and retained outputs, and start
the engine followed by the web process. Runtime environment files and PM2
configuration are generated from private host settings. Startup checks use log
files unique to the run, so previous startup lines cannot satisfy readiness.

Explicit failed-start recovery is staging-only and forces machinery mode. Before
replacing the unavailable candidate, the pipeline verifies its generated process
metadata, restart evidence, fresh never-ready stdout, and unreachable control
socket. A promoted engine or any evidence of readiness prevents the drain bypass.
Successful recovery follows the normal stop, backup, startup, and promotion path.

Explicit staging grid deletion belongs to the machinery lifecycle, after backup
and before the new engine opens storage. The pipeline validates the target and
keeps production storage isolated. The application migration handles production
records; disposable staging records do not require application compatibility paths.

Staging additionally compares served HTML with the retained frontend and checks
that a soft update preserves the engine instance. Production only observes PM2
state and startup logs. Failed startup leaves its phase and backup location in
the run record; the pipeline does not automatically restore a database or roll
back to code that might not understand a migrated schema. Retrying the command
uses current process state and verified artifacts.

## Data administration

The transfer command owns offline grid moves using canonical workflow records,
cell links, and ledger attribution. The application owns schema migration.
Artifact and thinking storage is shared by reference: transfer and administrative
deletion preserve bytes still owned by retained tasks. Account mapping belongs
to the move; sessions and inference credentials remain environment-local.

## Host prerequisites

SSH, tmux, flock, tar, rsync, Git, Node, pnpm, and PM2 are host prerequisites. The
configured pnpm version must match the application's package manager declaration.
Production requires private `OPS_MASTER_REPOSITORY` configuration and Git read access
from both machines to the authoritative repository. TLS, reverse proxies, DNS,
and installing system packages remain host operations.
New infrastructure or application entry points require changing this repository;
ordinary application commits do not.
