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

### Pending

- Actual plugin package scaffold
- Deterministic local dev stack
- Real OWS and Morpho adapters
- Structured logs and metrics
- End-to-end executable eval runner

## Next Implementation Step

Create the first real plugin package scaffold with:

- `package.json`
- `openclaw.plugin.json`
- `index.ts`
- CLI command registrar
- placeholder plugin config schema

## Risks

- The repo is still docs-first and script-stub-first, so implementation velocity is still limited.
- No executable end-to-end environment exists yet.
- Secret-management wiring is specified but not implemented.

## Success Criteria

This bootstrap plan is complete when a follow-up implementation plan can assume:

- all core docs exist in-repo
- scripts provide stable entrypoints
- eval cases are explicit and enumerable
- future plugin code can target documented boundaries instead of chat instructions
