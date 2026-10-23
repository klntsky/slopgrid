# Operations development

Run commands from the application worktree using `./ops/deploy.sh`, or from
`ops/` using `./deploy.sh`. Operations source is versioned with the application.

## Configuration

The ignored application-root `.env` supplies deployment settings; inherited
environment variables override its values. Configure these variables privately:

| Variables                                                         | Purpose                                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `OPS_HOST`                                                        | SSH destination                                                          |
| `OPS_REPOSITORY`                                                  | Local application checkout; defaults to the repository containing `ops/` |
| `OPS_MASTER_REPOSITORY`                                           | Authoritative Git repository for production eligibility                  |
| `OPS_REMOTE_ROOT`                                                 | Remote directory for tools and deployment runs                           |
| `OPS_NODE_PATH`                                                   | Remote executable search path                                            |
| `OPS_STAGING_STATE`, `OPS_PRODUCTION_STATE`                       | Independent runtime state directories                                    |
| `OPS_STAGING_CONFIG`, `OPS_PRODUCTION_CONFIG`                     | Remote generated configuration directories                               |
| `OPS_STAGING_APPLICATION_ROOT`, `OPS_PRODUCTION_APPLICATION_ROOT` | Roots for relative storage paths                                         |
| `OPS_STAGING_ENV_FILE`, `OPS_PRODUCTION_ENV_FILE`                 | Remote source runtime environments                                       |
| `OPS_STAGING_WEB_PROCESS`, `OPS_PRODUCTION_WEB_PROCESS`           | Distinct web process names                                               |
| `OPS_STAGING_ENGINE_PROCESS`, `OPS_PRODUCTION_ENGINE_PROCESS`     | Distinct engine process names                                            |
| `SLOPGRID_LOCAL_TEST_ENV_FILE`                                    | Optional private local test-credential file                              |

The initiating `.env` selects remote locations; each remote `runtime.env` remains
the source of application credentials and target settings. Supply the HTTPS
origin, listener port, output domain, encryption secret, and GitHub credentials
there. Relative data paths resolve against the target's application root.
The pipeline derives socket and retained-frontend locations and generates web
and engine environment files and a process-manager definition in the target's
configuration directory. Release pointers select web and engine code separately.
Source archives exclude the initiating `.env` and remote credentials.

Both machines need Git read access to the authoritative repository. Locally,
install Node, the application's declared pnpm version, tar, Git, and the browser
dependencies described in [application development](../DEVELOPMENT.md). Remote
operations require Linux with `/proc` mounted, plus SSH, tmux, flock, rsync, and
PM2. Runtime networking, TLS, DNS, and credentials must already be configured.

## Candidate validation and deployment

```sh
./deploy.sh --help
./deploy.sh help production
./deploy.sh validate
./deploy.sh validate HEAD --unit tests/publishing.test.ts --browser tests/e2e/grid-slugs.spec.ts
./deploy.sh rehearse HEAD --skip-tests
./deploy.sh staging HEAD
./deploy.sh production HEAD
./deploy.sh production HEAD --skip-tests
./deploy.sh production HEAD --plan
./deploy.sh status RUN_ID
```

Without a command, the CLI shows help and exits without deployment. Help requires
no configuration or infrastructure. Interactive help accepts a topic, `all`,
or `q` to exit.

REV defaults to the invoking application worktree's HEAD. Source and operations
changes must be committed. The command builds once locally and runs the selected
suites in an isolated workspace with temporary data, a private socket, and
OS-assigned ports. `validate` finishes locally without SSH or deployment.
Use `SLOPGRID_LOCAL_TEST_ENV_FILE` for private local test credentials.

Deployment uploads committed source, operations, and the validated frontend into
a fresh run directory. Keep that directory for status reconnection. The remote
worker installs host-native dependencies and verifies artifact manifests without
rebuilding the frontend or running suites.

Use one `OPS_REMOTE_ROOT`, deployment user, and PM2 instance for staging and
production. Different deployment roots controlling the same runtime or PM2
instance are unsupported. Before switching to this worker protocol, let all old
deployment workers finish. Do not restart old uploaded deployment requests.

Production requires the resolved revision to equal the freshly queried
authoritative `refs/heads/master` tip, checked locally and remotely. Production
runs the full local suites unless explicitly skipped. `--skip-tests` preserves
the master gate and migration rehearsal. Production updates only its own runtime.
Staging is a separately requested administrative target.

`rehearse` and production promotion take a read-only SQLite backup and independent
copies of all output files remotely, then initialize candidate storage and check
integrity and foreign keys. Private copies are removed after success or failure.
The database backup is transaction-consistent; the filesystem copy is not an
atomic checkpoint across both stores. Missing or unsafe sources and migration
failures stop promotion. Rehearsal changes neither persistent runtime.

`--mode auto` chooses a soft update when engine dependencies, runtime settings,
and the Node executable remain compatible. `--mode soft` rejects incompatible
changes. `--mode machinery` drains accepted work, stops processes, backs up data,
and replaces the engine and web process. Soft updates replace only web code and
retain the engine. Keep database, outputs, and encryption keys together in backups.

`--plan` uploads nothing and changes no runtime; a production plan still queries
the Git authority. Remote work continues in tmux `bg` after SSH disconnection.
Use the printed run ID with `status` to follow its log and final exit status.
Failed startup retains its phase and backup location for recovery. Reconcile a
blocked transaction before retrying through a fresh run ID. The pipeline does not
automatically restore an older database. `staging --recover-failed-start` permits
guarded machinery recovery only when the unpromoted candidate never became ready;
it does not override an unresolved deployment transaction.

If a competing deployment returns exit 75, wait for the current owner to finish
before retrying. Do not use TERM, HUP, or INT to cancel an admitted deployment;
those signals are deferred. Reconnect with `status` to observe its outcome.
If a run reports recovery required, use the reconciliation procedure below.

## Reconcile an interrupted deployment

Use SSH to inspect the deployment host. Keep the same lock held throughout
inspection and acknowledgement. Set `ROOT` to the configured `OPS_REMOTE_ROOT`:

```sh
exec 9>"$ROOT/deployment.lock"
flock -n 9 && cat "$ROOT/deployment-transaction.json"
```

If `flock` fails, an owner still holds the deployment lock. Stop this procedure.
Never remove or replace the lock file.

1. Preserve the recorded run's request, worker identity, logs, stage results,
   completion evidence, and backup location.
2. Establish that the interrupted worker and its mutating command descendants
   have stopped. A missing PID alone is insufficient. Inspect PM2 registrations
   and restart activity as well.
3. Inspect the engine and web release pointers, generated configuration, startup
   logs, deployment metadata, and saved PM2 state. Reconcile uncertain runtime
   state while holding the lock. Preserve potentially migrated data.
4. If quiescence or data compatibility remains uncertain, leave the transaction
   record in place and stop.
5. Record acknowledgement for the exact interrupted run in your incident record.
   Remove only its `deployment-transaction.json` after verifying that the record
   still identifies that run. Preserve the run directory and its permanent claim.
6. Release the lock with `exec 9>&-`. Retry the deployment command to create a
   fresh run.

Acknowledgement permits new deployment work. It does not restore an older
runtime or prove that a partial deployment was rolled back. Power-loss durability
and all-or-nothing visibility across processes and migrated storage are not
provided by deployment serialization.

## Local pipeline checks

```sh
./check.sh
./check.sh tests/isolation.test.mjs
./check.sh --test-name-pattern='argument policy' tests/pipeline.test.mjs
```

Install the local candidate application's dependencies before running the checks.
Run them on Linux with `/proc`, Git, pnpm, tar, flock, rsync, and PM2 available on
`PATH`. The runner needs no deployment configuration or SSH connection. It owns
temporary data and private `PM2_HOME` directories; leave shared PM2 instances
untouched.

## Data administration

Use repeated `staging --discard-grid ID` arguments to remove explicitly selected
staging grids after validation, drain, and backup. This requires machinery mode
and retains unselected grids and shared content.

`node grid-transfer.mjs` previews an offline grid move; pass `--apply` to perform
it. Provide `--app PATH`, source and target database and output paths, `--grid ID`,
`--remove-model MODEL`, and `--backup-dir PATH`. The destination account must
already exist. The command supports settled private SVG grids with model rows
and one column, canonical version 3 case inputs, and schema 17 storage. Sessions
and credentials stay in their original environment. Keep transfer paths and
backups in private host configuration.
