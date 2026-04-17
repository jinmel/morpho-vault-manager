# Agent Map

This repository is being built for an agent-first workflow. Treat the repository, not chat history, as the system of record.

## Start Here

- Product scope: [docs/SPEC.md](./docs/SPEC.md)
- Architecture: [ARCHITECTURE.md](./ARCHITECTURE.md)
- Security invariants: [SECURITY.md](./SECURITY.md)
- Progress tracker: [state/progress.json](./state/progress.json)
- Active implementation plan: [docs/exec-plans/active/bootstrap-harness.md](./docs/exec-plans/active/bootstrap-harness.md)
- Eval matrix: [evals/vault-manager-evals.md](./evals/vault-manager-evals.md)

## Repository Rules

- Keep the product narrow: Base-only, USDC-only, Morpho vault management only for v1.
- Do not introduce a custom OpenClaw `AgentHarness` unless the architecture docs are updated first.
- All signing must go through OWS. Never handle raw private keys in plugin code.
- The current live wrapper signs in OWS and broadcasts through Base RPC because the documented OWS CLI surface is `ows sign tx`, not a documented `signAndSend` command.
- Never store owner credentials in repo files, plugin config, or agent prompts.
- Morpho writes must follow `read -> prepare -> simulate -> OWS sign -> broadcast -> verify`.
- If a script or test contradicts prose docs, fix the docs or the script so they match. Do not leave split-brain behavior.

## Execution Discipline

- Prefer editing docs, plans, scripts, and evals together when changing behavior.
- Read `state/progress.json` before substantial work and update it when milestone status, blockers, or next actions change.
- When a task or milestone is completed, record that completion in `state/progress.json` before closing the work.
- When you add a new capability, also add:
  - the architectural note
  - the security impact
  - the script entrypoint or harness command
  - the eval case
- Keep files discoverable and named by domain, not by implementation detail.

## Current Repo Shape

- `docs/`: product and execution docs
- `scripts/`: operator- and agent-facing entrypoints
- `evals/`: deterministic acceptance scenarios and runbooks
- `state/`: machine-readable progress and status tracking
- `src/`: native plugin code, adapters, and rebalance runtime

## What To Avoid

- Large undocumented helpers
- Hidden operator steps
- Unbounded strategy logic
- Silent fallbacks around signing failures or simulation failures
- New product scope without updating the spec first
