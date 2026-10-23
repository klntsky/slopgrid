# Operations workflow

1. Keep deployment implementation in this `ops/` directory. Use `deploy.sh` for
   deployments and `check.sh` for pipeline validation. Do not create temporary
   operational scripts, patch installed implementation files, synthesize status
   files, or manually perform steps owned by the deployment command.
2. Staging and production deployments each require an explicit user request.
   Committing, pushing, or validating changes does not authorize deployment.
   Pass `--skip-tests` only
   when the user has explicitly skipped tests after candidate validation.
   Production otherwise requires the complete isolated candidate suite and must
   always pass the authoritative master-tip gate.
3. Commit and push related completed changes together using
   `git commit ... && git push` before deploying or reporting completion.
4. Pipeline and application tests run locally with isolated candidate runtimes through
   the permanent runners. Remote migration rehearsal is an operational check, not
   a test-suite runner. Agent-started background work runs in tmux session
   `bg`; fixture children are managed by their test runners.
5. Keep infrastructure values and secrets in the ignored application-root `.env`,
   not tracked code or documentation. Runtime data stays outside tracked source. Describe
   product requirements in PRODUCT.md, architecture in ARCHITECTURE.md,
   development and validation in DEVELOPMENT.md, and agent rules here. Keep
   README.md a brief introduction. Documentation must be ASCII and describe
   current behavior. Remove superseded requirements completely.
