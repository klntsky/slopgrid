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
operations also require SSH, tmux, flock, rsync, and PM2. Runtime networking,
TLS, DNS, and credentials must already be configured.

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

Deployment uploads committed source, operations, and the validated frontend.
The remote worker installs host-native dependencies and verifies artifact
manifests without rebuilding the frontend or running suites. Runtime deployments
take an exclusive lock; concurrent deployments fail rather than wait.

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
Failed startup retains its phase and backup location for recovery; inspect those
before retrying. The pipeline does not automatically restore an older database.
`staging --recover-failed-start` permits guarded machinery recovery only when the
unpromoted candidate never became ready.

## Local pipeline checks

```sh
./check.sh
./check.sh tests/isolation.test.mjs
./check.sh --test-name-pattern='argument policy' tests/pipeline.test.mjs
```

The runner uses the local candidate application's dependencies and isolated
fixtures. It needs no deployment configuration or SSH connection. Application
fixture dependencies must be installed before running it.

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
