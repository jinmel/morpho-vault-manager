---
name: vault-manager
description: >
  Operate within the repository contract for the Morpho vault manager plugin:
  configure a constrained OWS-backed wallet profile, generate workspace instructions,
  and manage periodic OpenClaw cron execution without widening product scope.
---

# vault-manager

Use this skill when working on the plugin itself.

## Repository Contract

- Product scope lives in `docs/openclaw-vault-manager-spec.md`
- Architecture lives in `ARCHITECTURE.md`
- Security invariants live in `SECURITY.md`
- Progress state lives in `state/progress.json`
- Evals live in `evals/vault-manager-evals.md`

## Operating Rules

- Stay Base-only and USDC-only for v1
- Do not add a custom OpenClaw `AgentHarness`
- Route all live signing through OWS
- Keep Morpho writes in the order:
  - read
  - prepare
  - simulate
  - policy check
  - sign/send
  - verify

## Required Follow-Through

When adding or changing behavior:

1. update docs if the contract changed
2. update `state/progress.json`
3. update or add an eval row
4. keep commands and prompts aligned with the security model
