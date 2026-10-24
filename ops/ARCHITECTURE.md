# Deployment architecture

The deployment pipeline separates local candidate preparation, remote release
management, and application-owned migration. Configuration and commands belong
in [DEVELOPMENT.md](DEVELOPMENT.md).

## Candidate preparation and trust

The initiating command resolves committed application and operations source,
builds the frontend locally, and owns local suite execution in an isolated
candidate runtime. Source and artifact identities accompany validation results
across the upload boundary.

The remote worker verifies those identities and installs host-native
dependencies. It owns runtime promotion without rebuilding the validated
frontend or executing test suites. Both sides independently consult the
authoritative Git repository before production changes; local branch naming
does not establish production eligibility.

Private initiating configuration selects independent target environments.
The shared runtime environment boundary requires both nonblank GitHub OAuth
credentials before deployment proceeds. Remote application credentials remain
outside release source and local test services. The pipeline derives process
configuration from the selected target rather than allowing candidate defaults
to select persistent runtime state.

## Migration rehearsal and storage

Operations owns safe snapshots, independent output copies, integrity checks,
and temporary-data cleanup. Application storage initialization owns migration
of those copies into its canonical representation. The live production stores
remain outside candidate mutation boundaries.

Rehearsal is independent of test-suite execution and persistent runtime
deployment. Its evidence describes migration success without retaining copied
private records. Runtime backup and offline transfer respect the application's
shared-content ownership boundary.

## Release and process lifecycle

Releases are immutable. The pipeline retains frontend assets needed by open
pages and keeps web and engine release ownership separate. Compatible updates
replace the web process while the engine retains accepted work. Incompatible
updates use the application's admission and drain boundary before replacing
the engine.

Each run owns its uploaded tools and inputs. Exclusive run admission prevents
duplicate workers from replacing that run's logs or completion evidence.
Runtime admission serializes the shared process-manager and persistent runtime
changes through terminal publication. Staging and production share this admission
boundary even though their configuration, data, and application processes are
separate. Independent candidate work owns separate build and runtime resources.
Production promotion does not depend on deploying staging.

## Local demo ownership

Demo preparation shares the local candidate build and validation boundary.
Its runtime stays under the invoking user's account instead of crossing the
remote deployment boundary. Run-owned source, credentials, and storage keep
demo effects separate from staging and production.

Before archiving source, creating a run, or building, the CLI reads the required
GitHub pair from the staging environment over SSH. This read is independent of
data acquisition and also runs for retained-data reuse. A missing or unreadable
pair stops deployment. Local, inherited, and retained GitHub credentials cannot
replace it. Only the pair crosses this boundary, never the full environment,
database, or release pointer. The reader caps stdout at 64 KiB, kills SSH after
20 seconds, and reports fixed errors without remote output or exception details.

The pair stays in a CLI local variable until an explicit fourth argument passes
it to `startDemo`. That boundary validates it before runtime operations and maps
only its two fields into private `demo.env` and `runtime.json` files. Requests,
results, leases, logs, and process arguments never contain it. The copied
standalone supervisor needs no credential-reader module. Local test validation
keeps using separate fixture credentials. Plans validate source configuration
without making SSH calls; help does not load configuration.

The GitHub application's registered callback must already match the demo origin.
Copying credentials does not modify the staging OAuth registration.

Optional staging data acquisition crosses a separate read-only snapshot boundary.
The installed SQLite driver reads staging data without invoking application
initialization against the source or controlling its services. Candidate
initialization runs only on an independently owned local copy and decides
whether that data is usable. Operations discards a rejected import before
publishing fresh storage, so incompatible staging data does not become a
runtime dependency or a reason to repair staging.

Imported ownership and access rules remain application responsibilities.
Separate demo cookies prevent ambient browser identity sharing, while private
storage protects the copied session credentials and encryption key. Importing
data does not authorize a new anonymous browser to read private staging grids.

The systemd user manager owns the demo process group and enforces its lifetime
outside the initiating command. Tailscale owns the private HTTPS listener through
the foreground Serve session in that group. Stopping the group removes that
session without changing unrelated listeners. Operations records the stopped
lifecycle while retaining application data and its encryption key.

Runtime observation matches the service invocation to its run record so a later
demo cannot make an older run appear active. Host administration owns user-manager
availability, Tailscale permission, OAuth registration, and output-host routing.

## Observation and recovery

Each remote run owns its lifecycle record, logs, and exit status. Status
reconnection observes that same run rather than inferring success from a
previous deployment. Process state and fresh startup evidence establish
production readiness without application verification requests.

The pipeline owns promotion and records failures. An interrupted deployment
retains an ownership record that blocks successors even after an operating-system
lock is released. Operator reconciliation, not missing process liveness, permits
new runtime mutations. Catchable signals defer termination while deployment
operations retain ownership.

Exclusive execution does not make code, process state, and migrated storage a
single rollback transaction. Recovery decisions preserve the boundary between
code replacement and potentially migrated data rather than assuming an older
release can read a newer store. Host networking, TLS, DNS, and system-package
administration remain outside application deployment.
