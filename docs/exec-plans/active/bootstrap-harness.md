# Bootstrap Harness Plan

## Objective

Build the repository scaffold needed to make the vault-manager plugin tractable for an agent-first workflow before implementing the plugin itself.

## Why This Exists

The product spec defines behavior, but the harness defines whether an agent can reliably build, validate, and maintain that behavior.

This plan exists to ensure the repo becomes:

- legible
- executable
- testable
- auditable

## Deliverables

### Repository Guidance

- `AGENTS.md`
- `ARCHITECTURE.md`
- `SECURITY.md`

### Execution Entry Points

- `scripts/dev/up`
- `scripts/dev/reset`
- `scripts/rebalance/dry-run`
- `scripts/rebalance/live-run`
- `scripts/check/policy`
- `scripts/check/cron`
- `scripts/check/configure`

### Evaluation Layer

- `evals/vault-manager-evals.md`
- `evals/README.md`

## Current Status

### Completed

- Product spec created
- Harness scaffold docs created
- Script entrypoint stubs created
- Initial eval matrix created
- Native plugin package scaffold created
- Initial CLI implementation created
- Profile state and workspace generation implemented
- Real Morpho read/prepare dry-run engine implemented
- Live execution wrapper implemented with OWS signing and Base RPC broadcast
- Rebalance scripts now execute the real runtime instead of stubs

### Pending

- Deterministic local dev stack
- End-to-end live verification against installed `openclaw` and `ows`
- Structured logs and metrics
- End-to-end executable eval runner

## Next Implementation Step

Build the reproducible local and verification layer around the implemented runtime:

- deterministic OpenClaw + OWS + Morpho local environment
- executable eval runner for dry-run and live-run scenarios
- cron run verification in a real gateway process
- richer structured logs and metrics

## Risks

- No executable end-to-end environment exists yet for OpenClaw + OWS together.
- Live execution has code coverage but not end-to-end validation in this machine because `openclaw` and `ows` are not installed.
- Token provisioning still depends on operator-controlled environment setup.

## Success Criteria

This bootstrap plan is complete when a follow-up implementation plan can assume:

- all core docs exist in-repo
- scripts provide stable entrypoints
- eval cases are explicit and enumerable
- future plugin code can target documented boundaries instead of chat instructions
- the initial native plugin package scaffold already exists
