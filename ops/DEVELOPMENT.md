# Operations development

Run commands from the application worktree using `./ops/deploy.sh`, or from
`ops/` using `./deploy.sh`. Operations source is versioned with the application.

## Configuration

The ignored application-root `.env` supplies operations settings; inherited
environment variables override its values. Configure remote deployments privately:

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
origin, listener port, output domain, encryption secret, and both
`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` there. Deployment rejects either
missing or blank GitHub credential. Relative data paths resolve against the
target's application root.
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

## Run a temporary demo as your user

Configure these local settings in the ignored application-root `.env`:

| Variable | Purpose |
| -------- | ------- |
| `OPS_DEMO_ENV_FILE` | Absolute path to a private local demo environment file |
| `OPS_DEMO_HTTPS_PORT` | Default unused Tailscale HTTPS listener port; overridden by `--https-port PORT` |
| `OPS_DEMO_STATE_ROOT` | Optional absolute directory for retained demo runs |
| `OPS_HOST` | Required staging SSH destination |
| `OPS_NODE_PATH` | Required remote executable search path |
| `OPS_STAGING_ENV_FILE` | Required absolute staging environment path for GitHub credentials |
| `OPS_STAGING_APPLICATION_ROOT` | Required absolute staging application root for default data cloning |
| `OPS_STAGING_CONFIG` | Required absolute staging configuration directory for default data cloning |

The default state directory is `$XDG_STATE_HOME/slopgrid/demos`, or
`$HOME/.local/state/slopgrid/demos` when `XDG_STATE_HOME` is unset.
Demos require the staging credential source above, but no production settings.

Install the local build dependencies listed above, Tailscale, and a systemd user
manager. Enable HTTPS for the tailnet and grant your user permission to use
Tailscale Serve. Ask the host administrator to enable lingering for your account
with `loginctl enable-linger USER` so the user manager survives logout.

Create the dedicated demo environment file with mode `0600`. Omit `PORT` or set
it to `0` for an OS-assigned loopback backend port reported in the demo lease.
A fixed backend port is also supported, but an occupied port is rejected.
Supply a demo-only `OUTPUT_DOMAIN`. The app origin uses the current node's
Tailscale DNS name and `OPS_DEMO_HTTPS_PORT`. If `APP_ORIGIN` is present, it must
match that derived origin.

Every demo reads both GitHub credentials from staging before archiving source,
creating a run, or building, including `--reuse-demo` and `--skip-data-cloning`.
Missing, blank, partial, or unreadable staging credentials stop deployment.
Credentials in the local demo file, inherited environment, or retained demo
are ignored. The SSH read returns only the credential pair, with a 20-second
deadline and a bounded response. Failures never print remote output or
credential values.

Copying these credentials does not change GitHub's registered callback. The
OAuth application must already allow the demo's exact origin at
`/api/auth/github/callback`. The command does not modify the staging OAuth
registration. OpenRouter callbacks use `/api/auth/callback`.

Tailscale Serve supplies HTTPS for the app hostname. HTML outputs still require
independent wildcard DNS, trusted TLS, and proxy routing to the backend port
recorded in the lease. Use a hyphen-prefixed `OUTPUT_DOMAIN` as required by the application.
Do not point that routing at staging or production. The demo command does not
provision wildcard output hosting or OAuth applications.

```sh
./deploy.sh demo --plan
./deploy.sh demo
./deploy.sh demo HEAD --unit tests/publishing.test.ts
./deploy.sh demo HEAD --skip-tests
./deploy.sh demo HEAD --https-port 8446 --skip-tests
./deploy.sh demo HEAD --skip-data-cloning --skip-tests
./deploy.sh status RUN_ID
systemctl --user stop slopgrid-demo-RUN_ID.service
```

After acquiring staging GitHub credentials, the command builds and validates
committed source locally, then prints the private HTTPS URL, deadline, and data
location. Full local validation is the default. Scoped selection and explicit
skipped tests use the same controls as candidate validation. Runtime processes
run as the invoking local user without PM2. Multiple demos can run concurrently
on distinct HTTPS listener ports. `demo --plan` validates source configuration
but reads no staging credentials or data and makes no SSH calls.
Every new run owns `slopgrid-demo-RUN_ID.service`, a private runtime, and a distinct
`__Host-slopgrid-demo-RUN_ID` session cookie. Cookies ignore port numbers, so the
separate names prevent browser identity sharing between demos on one hostname.
Starting or stopping one run does not stop another run's service or listener.
Use `--https-port PORT` for each additional demo and `PORT=0` for dynamic backends.
Output hosting still needs independent routing for each demo's selected backend;
one shared output-domain upstream cannot serve different retained data safely.

The service stops after 24 hours of runtime, including startup. Expiry kills
generation without draining accepted work. Upstream provider work can still
incur charges after local processes stop. Early stop uses the same service
command shown above. Neither stop nor expiry deletes the database, outputs,
generated environment, or encryption key. Keep the retained data private.
Remove an old run directory manually only after its service has stopped.

### Clone staging data by default

Ordinary `demo` commands require a staging data clone. Configure valid absolute
`OPS_STAGING_APPLICATION_ROOT` and `OPS_STAGING_CONFIG` paths alongside the
credential-source settings. Missing or invalid data paths stop the command
before Git, SSH, build work, or run creation. No production settings or remote
deployment process names are required.

A separate SSH read uses the installed release's SQLite driver to take an online
database backup. Staging stays running. The command copies outputs, including
hidden reference and thinking files, and the encryption key into private local
storage. This data import does not supply OAuth settings, listener addresses,
or cookie names.

The prepared candidate checks this copy through its existing storage
initialization and interrupted-work recovery. It uses only migrations already
in that candidate. An unavailable, unsafe, or incompatible snapshot stops
deployment before a demo service or listener starts. Rejected imports are
discarded without installing empty replacement storage. `--skip-tests` skips
suites, not required cloning or storage compatibility checks.

Use `--skip-data-cloning` to explicitly initialize an empty database, independent
outputs, and a new encryption key. This flag makes no staging data copy, even
when the source is configured. It does not require staging data paths, but the
staging GitHub credential source remains required. CLI output and `status`
distinguish imported data from an explicit fresh-data deployment.

Imported data retains its ownership and visibility. Public grids remain visible;
private account-owned grids require signing into the same account in the demo.
A new anonymous browser does not gain access to anonymous private staging grids.
Sign-in uses the required staging GitHub credential pair described above.
Copied sessions can contain usable provider credentials, so protect retained
demo storage and its encryption key as private staging data.

The database and output tree are sequential copies, not one atomic snapshot.
Changes during copying can cause import rejection and stop deployment. Normal
recovery pauses interrupted work without starting inference. Resuming copied
work later can incur charges independently of any work still running in staging.
Local storage failures and later service-start failures remain deployment errors.

### Redeploy with a retained demo's data

`--reuse-demo RUN_ID` takes priority over staging import and is available only
for `demo`. It creates an independent snapshot of a retained local demo,
preserving browser sessions, grids, outputs, and the encryption key needed to
decrypt saved credentials. It does not borrow staging or production storage.
It does not require staging data paths and cannot be combined with
`--skip-data-cloning`.

Commit the candidate and operations changes first. Inspect the reuse plan before
stopping the old demo, then stop the service explicitly and deploy:

```sh
./deploy.sh demo REV --reuse-demo RUN_ID --skip-tests --plan
systemctl --user stop SOURCE_SERVICE_FROM_STATUS
./deploy.sh demo REV --reuse-demo RUN_ID --skip-tests
```

Use the exact service printed by `status`. Older retained runs can still record
`slopgrid-demo.service`; status and source checks use that recorded unit.

`RUN_ID` names a direct child of the configured demo state directory. The source
must have an existing `stopped`, `expired`, or `failed` demo lease and its runtime
must be exactly `RUN_ID/demo`. An active service is rejected, never stopped
implicitly. Paths must be canonical, current-user-owned directories or regular
files, without symlinks, hardlinked files, or group/other write permissions.
The source environment must be private, its database and output paths must point
inside its own runtime, and its encryption key must contain exactly 64 hex digits.
Unsafe or incomplete sources, including retained SQLite rollback journals, stop
the deployment before service launch.

The command copies the source SQLite database and optional WAL into private
scratch storage. Candidate-installed `better-sqlite3` opens only that copy
read-only and backs it up to the new runtime. It never opens source SQLite or
copies its shared-memory file. Every output file, including hidden files, gets
an independent copy. The source database, WAL, shared memory, outputs, environment,
and lease remain unchanged. The new lease records only the source run ID.

The destination gets a new socket, temporary directory, built frontend, and
private environment. Reuse carries over the encryption key. At the same origin,
it also preserves the source session cookie name, using `__Host-slopgrid` when an
older source has no explicit name. Origin, ports, and output domain come from
the current demo configuration. GitHub credentials are freshly read from staging
and never reused from retained storage. At a different origin, reuse
gets a fresh isolated cookie name; existing anonymous browser cookies are not
carried across origins. Keep the same origin and output routing to retain
browser sessions and output links. Candidate storage initialization performs
migrations after copying and before readiness; a migration failure leaves both
the original and failed destination data retained for inspection.

Keep the source stopped throughout copying. Metadata and active-service checks
reject observed changes, but this is not a lock against another same-user process
editing or restarting the source. The database/filesystem pair is not a live
atomic snapshot. Stopping the old demo before the command also means downtime
during candidate installation and build; the CLI does not switch an active demo
or roll back automatically. No source data or old frontend is deleted.

For a focused deployment smoke, retain the original database, WAL, environment,
and output hashes after stopping. After reuse, compare those hashes, confirm the
new runtime uses different file inodes and the same encryption key without
printing it, and use the existing browser cookie to open old grids and outputs
at the unchanged origin. Confirm the new schema through normal app startup.
`--plan` creates no run, reads no source data, and reports the copy and migration
steps without launching services.

Use `status` with the printed run ID to inspect a local demo before any remote
status lookup. Runtime output is in the run's `demo.log`; the service journal
is available with `journalctl --user -u SERVICE_FROM_STATUS`.

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
