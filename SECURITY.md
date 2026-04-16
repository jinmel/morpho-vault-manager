# Security

## Security Goal

The system must let an agent manage a constrained Morpho vault portfolio without ever granting that agent unconstrained wallet access.

## Primary Threat Model

We assume:

- the model may hallucinate or choose an unsafe action
- the local machine is trusted enough to run OpenClaw and OWS, but the agent should still operate under least privilege

We do not assume the prompt alone will prevent unsafe execution.

## Non-Negotiable Invariants

- Owner credentials never enter agent-visible runtime state.
- Raw private keys never appear in plugin code, logs, prompts, config, or repo files.
- The agent receives only an OWS API token.
- The rebalance runtime only forwards transactions produced by `morpho-cli` prepare flows to OWS. No code path accepts agent-authored calldata.
- Live execution is allowed only on Base for v1.
- Live execution is allowed only for USDC Morpho vault operations for v1.
- All live signatures must come from OWS.
- Simulation failure aborts execution.

## Credential Model

### Owner Credential

- Full wallet authority
- Must never be used by the periodic vault-manager agent

### OWS API Token

- Scoped to one wallet for v1
- The only credential the agent may use
- In v1, the raw token is provisioned out-of-process so the plugin never needs to load it into process memory

### Broadcast Path

- Current implementation uses OWS for signing and Base RPC for broadcast plus receipt verification.
- This does not widen secret access: the signing boundary remains inside OWS.
- When the OWS CLI exposes a documented `signAndSend` surface, the plugin should move broadcast into OWS as well.

## OWS Policy Model

The plugin does not create, attach, or enforce custom OWS policies.

OWS default policy behavior is left untouched. The plugin's enforcement point is the runtime path around OWS:

- only `morpho-cli` prepare flows may produce transactions for signing
- no code path accepts agent-authored calldata and hands it to OWS
- Base-only, USDC-only, turnover, and simulation constraints are enforced in the plugin runtime before signing

If a future change allows calldata to reach OWS through any path other than Morpho prepare output, the trust model must be re-evaluated and documented before merge.

## Morpho Skill

Morpho protocol interaction is provided via the `morpho-cli` workspace skill (from [`morpho-org/morpho-skills`](https://github.com/morpho-org/morpho-skills/)). The skill provides CLI-based query and prepare commands that return unsigned transactions. The rebalance runtime uses `morpho-cli` directly and runs under the narrow AGENTS.md contract.

## Logging Rules

- Do not log owner credentials, API tokens, private keys, mnemonics, or raw decrypted secret material.
- If logging command lines, redact secrets and token-like strings.
- If logging transaction plans, prefer summarized transaction metadata over full sensitive payload dumps unless debugging is explicitly enabled.

## Storage Rules

- Do not commit secrets to the repo.
- Do not write owner credentials into OpenClaw prompts or workspace files.
- API tokens must be resolved through the configured token source (`env` or `file`), never hardcoded in profile JSON or plugin config.
- `file` sources are intended for mounted-secret setups (Docker/k8s/systemd EnvironmentFile). File contents are read at execution time and never copied into the profile.
- Profile files may contain public addresses, wallet IDs, thresholds, cron metadata, delivery targets/account ids, and the token source descriptor (kind + identifier), never the token value itself.
- The configure flow should emit the OWS API-key provisioning command and then accept only the resulting token source descriptor, not the raw token.

## Cron Delivery

- Cron delivery routing is public operational metadata, not secret material.
- A profile may store `deliveryChannel`, `deliveryTo`, and `deliveryAccountId` so each managed agent can announce to a different chat destination.
- The default delivery route should be OpenClaw's `last` channel target unless the operator pins an explicit destination.
- Discovery of Telegram groups/topics should use OpenClaw CLI directory surfaces only; the plugin must not scrape or persist unrelated chat history to infer a target.

## Execution Guardrails

- `scripts/rebalance/live-run` must refuse to execute unless an explicit arming control is present.
- Configure flows should default to dry-run validation before first live execution.
- All transaction execution wrappers must check:
  - chain
  - asset scope
  - simulation result
  - final receipt verification after broadcast

## Review Checklist

Every write-path change should be reviewed against these questions:

1. Does any new code handle sensitive material directly?
2. Can this path produce a live transaction after a failed simulation?
3. Can this path forward calldata to OWS that did not come from a `morpho-cli` prepare flow?
4. Can this path operate on a non-Base chain or non-USDC asset?
5. Is the failure mode explicit and visible to the operator?

If any answer is "yes", the change is blocked until the architecture and security docs are updated and the guardrail is encoded mechanically.
