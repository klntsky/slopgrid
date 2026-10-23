# Slopgrid operations

Slopgrid operations builds, validates, rehearses migrations, and deploys committed
Slopgrid releases through one command. It owns the complete deployment
implementation, including remote installation, draining, backups, and final status.

For work on the operations implementation, see [DEVELOPMENT.md](DEVELOPMENT.md).

## Shell scripts

| Script          | Purpose                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `deploy.sh`     | Command entrypoint for candidate validation, full-data migration rehearsal, deployment, and status.                                      |
| `check.sh`      | Run operations regression checks locally with isolated fixtures.                                                                         |
| `remote-run.sh` | Internal remote pipeline worker; records logs and status and locks deployments while allowing independent validation and rehearsal runs. |

Run the commands below from `ops/`.

## Configuration

Operations code lives in `ops/` in the application repository and is versioned
with the application. Deployment uploads the committed operations subtree from
the invoking checkout alongside the selected application revision. All local
infrastructure settings come from the application repository root `.env`, which
is ignored by Git. Environment variables override file values for automation.

Configure these variables without committing their values:

| Variables                                                         | Purpose                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OPS_HOST`                                                        | SSH destination, including an account or alias when required                                                     |
| `OPS_REPOSITORY`                                                  | Local application checkout, relative to the repository root or absolute; defaults to the current repository root |
| `OPS_MASTER_REPOSITORY`                                           | Authoritative application's Git repository URL                                                                   |
| `OPS_REMOTE_ROOT`                                                 | Absolute remote directory for tools, runs, and checks                                                            |
| `OPS_NODE_PATH`                                                   | Complete remote executable search path                                                                           |
| `SLOPGRID_LOCAL_TEST_ENV_FILE`                                     | Optional private local test-credential file                                                                      |
| `OPS_STAGING_STATE`, `OPS_PRODUCTION_STATE`                       | Absolute runtime state directories                                                                               |
| `OPS_STAGING_CONFIG`, `OPS_PRODUCTION_CONFIG`                     | Absolute generated configuration directories                                                                     |
| `OPS_STAGING_APPLICATION_ROOT`, `OPS_PRODUCTION_APPLICATION_ROOT` | Absolute roots for relative runtime storage paths                                                                |
| `OPS_STAGING_ENV_FILE`, `OPS_PRODUCTION_ENV_FILE`                 | Private deployed runtime environment files                                                                       |
| `OPS_STAGING_WEB_PROCESS`, `OPS_PRODUCTION_WEB_PROCESS`           | Distinct web process names                                                                                       |
| `OPS_STAGING_ENGINE_PROCESS`, `OPS_PRODUCTION_ENGINE_PROCESS`     | Distinct engine process names                                                                                    |

Both the initiating machine and remote host need Git read access to
`OPS_MASTER_REPOSITORY`. There is no fallback to a local branch, cached tracking
ref, or request-supplied master SHA. Missing configuration, missing master, and
query failures reject production, including plans and explicit test skips.
Real-provider tests also support the application's existing private test
configuration. The root `.env` is never included in source or tools archives.

Each target's `envFile` is the private source of application configuration.
Relative database and output paths resolve against `applicationRoot`; they never
resolve against a release directory. Provide the port, HTTPS application origin,
output domain, encryption secret, and GitHub credentials required by Slopgrid.
The pipeline derives absolute storage paths, socket paths, and retained frontend
paths, and writes process-specific environment files under the target's config
directory. It does not print credentials or copy them into releases.

The initiating `.env` selects configuration locations; the remote runtime files
remain the source of application credentials and target settings. A deployment
generates separate web and engine environments and a process-manager definition
beside each target's source environment. Release pointers select immutable code
independently for web and engine, so a soft update can advance the web release
while the engine continues using its existing release and persistent data.

Install Node 22.12 or newer, the pnpm version declared by Slopgrid, PM2, tmux,
flock, tar, rsync, Git, and the browser dependencies required by Slopgrid tests.
The configured SSH account owns the runtime files and runs PM2. Existing split
deployments can be adopted through their release pointers and process names.
Fresh split deployments start with machinery mode and create runtime directories;
host networking and runtime credentials must already exist.

## Commands

Use `./deploy.sh --help` for all commands and options, or
`./deploy.sh help rehearse` (equivalently `./deploy.sh rehearse --help`) for a
command-specific topic. Help requires no `.env`, Git repository, SSH access, or
infrastructure. In an interactive terminal, choose a command name or `all` to
browse help, then enter `q` or an empty line to exit. Piped help prints and exits.
Running `./deploy.sh` without arguments opens help, never a deployment.

```sh
./deploy.sh validate
./deploy.sh validate HEAD --unit tests/publishing.test.ts --browser tests/e2e/grid-slugs.spec.ts
./deploy.sh rehearse HEAD --skip-tests
./deploy.sh rehearse HEAD --unit tests/storage.test.ts
./deploy.sh production HEAD
./deploy.sh production HEAD --skip-tests
./deploy.sh production HEAD --plan
./deploy.sh status RUN_ID
```

The revision can be a Git commit, branch, or tag; HEAD is the default. Invoke the
command from an application worktree to select that worktree automatically.
Only worktrees of the configured application repository are recognized; commands
from other directories use the configured checkout. Application and operations
source must be committed before uploading. Validation uses run-owned
build/source workspaces, isolated temporary data, a private generation socket and
PM2 home, and OS-assigned test ports (`E2E_PORT=0`). Application test runners must
support that port contract. Inherited or private test configuration cannot select
shared runtime storage or ports.

Production accepts only a resolved commit equal to the freshly queried
`refs/heads/master` tip in `OPS_MASTER_REPOSITORY`; historical master commits and
divergent worktree commits are rejected. A branch name is not authorization.
The local gate runs before any upload; the remote pipeline independently checks
before runtime operations, after tests, and immediately before promotion.
`--skip-tests` never bypasses it. Production deploys only the single configured
production runtime; it never deploys or depends on staging.

`rehearse [REV]` builds and tests a committed candidate locally, then remotely
checks its migrations against a private full copy of live production data. It
does not replace shared staging, prepare a persistent runtime, acquire the
deployment lock, or promote production. The default runs the complete suites;
`--skip-tests` runs the migration rehearsal alone. Normal `validate` uses fresh data.

Production promotion always requires the same full-data rehearsal, including
with `--skip-tests`. SQLite's read-only online backup includes committed WAL
data. The complete output directory is copied independently before candidate
storage initialization runs SQL and file migrations. Missing sources, symlinks,
special files, migration errors, and failed SQLite integrity or foreign key
checks fail the run.

Production stays online. The database backup is transaction-consistent; the
live filesystem copy is not an atomic cross-storage checkpoint. Local test
fixtures use their own data; remote rehearsal does not execute test suites.
Production runtime credentials are not passed to validation services. Private database and output
copies are deleted after success or failure; the validation result retains
aggregate copy size and schema versions.

`--plan` uploads nothing and changes no runtime; production plans query master.
`--mode soft` rejects incompatible engine changes; `--mode machinery` drains
and replaces the engine; automatic mode is the default. The explicit `staging`
target remains an administrative deployment, not a shared worktree testing target.
`validate --mode=auto` is accepted as an explicit default, not a deployment;
other validation modes and all rehearsal mode options are rejected.

Each remote run retains its request, source archive, log, validation result,
phase record, and exit status. A disconnected client can reconnect with the
printed status command. A nonzero result is a failed deployment, even when a
previous run succeeded. Concurrent runtime deployments fail with an explicit lock
error; independent `validate` and `rehearse` runs do not acquire the deployment
lock. Correct the reported cause and repeat the same command; do not fabricate status
files or patch installed code. If startup fails after migration, use the recorded
backup and phase to assess recovery before changing live data.

## Moving a grid between environments

Run `node grid-transfer.mjs` on the host with `--app PATH` pointing to an
installed application release, `--source-db PATH`, `--target-db PATH`,
`--source-outputs PATH`, `--target-outputs PATH`, `--grid ID`,
`--remove-model MODEL`, and `--backup-dir PATH`. Paths and environment settings
belong in private host configuration or operator commands outside this repository.

The default invocation previews a move without changing data. Add `--apply`
to move a settled private canonical-input SVG grid with model rows and one column,
omitting one failed model. Both databases must use schema 17 and current version 3
case-record inputs. The destination must already contain the matching account.
The command preserves the grid ID, remaining artifacts, thinking, and call history,
and does not copy sessions or credentials. Keep the backup for recovery.

A destination collision aborts the command. If interrupted after the destination
was committed, both copies may remain; inspect them before proceeding and do not
overwrite the destination. This operation moves data without deploying code or
making production HTTP requests.
