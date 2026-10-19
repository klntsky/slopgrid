# Development

For configuration and operator commands, see [README.md](README.md).

## Validation

Run `./check.sh` for the pipeline's own regression checks. The permanent runner
uploads working source to the staging host and runs tests in tmux bg with isolated
temporary data. It uses dependencies from the current staging release and never
deploys or sends requests to production. Test-managed child processes and fixture
directories are separate from deployment scripts.

Coverage includes CLI validation policy, target isolation, real transitive
engine fingerprints, artifact corruption, promotion ordering and failure gates,
environment quoting, SQLite and output backups, real deployment locking,
fresh per-run exit status, and startup/failure detection through an isolated
PM2 daemon. Application validation is selected by the command and runs in
per-run workspaces on the configured host, never against staging or production
runtime data. A skipped test run is recorded as skipped, never passed.

Focused workflow checks (fixture adapters, no deployment):

```sh
./check.sh tests/isolation.test.mjs
./check.sh --test-name-pattern='one isolated build|real lock|argument policy' tests/pipeline.test.mjs
```

The isolation checks exercise authoritative Git refs, CLI rejection before SSH,
direct production rejection with skipped tests, post-test master movement,
overridden shared environment settings, and concurrent real remote runners
using per-run build/validation state while the production lock is held.

The pipeline has no third-party dependencies of its own. Runtime fingerprinting
and SQLite backups use the deployed application's dependencies. New deployment
behavior should have focused regression coverage at its responsibility boundary.

## Grid transfer checks

Run `tests/grid-transfer.test.mjs` on staging with `SLOPGRID_TEST_APP` pointing
to an installed staging release. Its isolated databases and output directories
cover ownership mapping, exclusion of a failed model, byte preservation, backups,
read-only preview, collision and active-work rejection, and import rollback.
