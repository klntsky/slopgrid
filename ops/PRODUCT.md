# Deployment requirements

1. One command must prepare and validate any committed application revision,
   including worktree candidates, using the implementation in this repository.
   Only the authoritative master tip may be published to the single production
   runtime. Resolve commits and query the configured Git authority independently
   locally and remotely; neither branch-name arguments nor skipped stages authorize
   production. Missing or unreachable authority fails closed.
2. Candidate validation must use independent build/source workspaces, temporary
   data, sockets, process-manager homes, and OS-assigned ports. Tests must not
   mutate shared staging or production runtimes. Explicit staging remains
   an administrative target, isolated from production.
3. Build once per run and promote that exact frontend artifact to production.
   Production defaults to the complete unit, mock browser, and real-provider
   browser suites; an explicit `--skip-tests` records the decision and skips tests,
   but still requires the production database migration rehearsal.
   `validate` also supports scoped tests and never deploys a persistent runtime.
   Production promotes only its configured runtime after authoritative-master
   authorization, independent of staging.
   - In validation run by `deploy.sh`, give each real-provider browser test up to
     three total attempts: one initial attempt and at most two retries. Stop
     after the first successful attempt; failure on all three prevents promotion.
     Keep unit, mock-browser, and GitHub tests single-attempt. Direct browser-test
     commands remain single-attempt by default.
   - Before production promotion, take a consistent read-only snapshot of the real
     production database without copying output artifacts.
   - Run the candidate's database migrations on the isolated snapshot, then seed
     database-backed service tests from the migrated data. Keep schema-specific
     unit fixtures independent.
   - Missing production data, migration failure, or test failure must prevent
     promotion. Delete the temporary database copies after success or failure.
4. Choose soft updates when engine dependencies, package configuration, runtime
   configuration, and the Node executable are compatible. Otherwise drain
   accepted work without a timeout, back up retained data, and replace the engine.
5. Preserve sessions, credentials, outputs, and frontend assets needed by open
   pages. Never overwrite source in an existing release. Failed validation must
   prevent runtime promotion. Concurrent candidate validation must not contend
   on the production deployment lock or write another candidate's runtime state.
6. The initiating command waits for the final result and returns its exit code.
   Deployment continues in remote tmux after SSH disconnects. Every run has an
   independent log and status, with the application and operations commits.
7. Production startup is observed through fresh process logs and process state,
   without production tests or HTTP verification requests.
8. Explicitly selected staging grids may be discarded as part of deployment.
   Validation must pass first; then drain, stop, and back up before deleting
   their records, call history, creation receipts, outputs, and thinking traces.
   Retain unselected grids, their shared artifacts and traces, and all sessions.
   Reject deletion for production, shared storage paths, and forced soft updates.
9. Grid transfers preserve generation and judgment state, ordered inference
   history, generated outputs, and thinking traces. Source removal keeps bytes
   required by other grids. The destination account identity must already
   exist; sessions and credentials stay in their original environment.
