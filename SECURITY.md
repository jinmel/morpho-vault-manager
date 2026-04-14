# Security

## Security Goal

The system must let an agent manage a constrained Morpho vault portfolio without ever granting that agent unconstrained wallet access.

## Primary Threat Model

We assume:

- the model may hallucinate or choose an unsafe action
- prepared Morpho transactions may include approvals that need strict checking
- the local machine is trusted enough to run OpenClaw and OWS, but the agent should still operate under least privilege

We do not assume the prompt alone will prevent unsafe execution.

## Non-Negotiable Invariants

- Owner credentials never enter agent-visible runtime state.
- Raw private keys never appear in plugin code, logs, prompts, config, or repo files.
- The agent receives only an OWS API token.
- Every agent write path is subject to OWS policy enforcement before decryption.
- Live execution is allowed only on Base for v1.
- Live execution is allowed only for approved USDC Morpho vault operations for v1.
- All live signatures must come from OWS.
- Simulation failure aborts execution.
- Policy denial aborts execution.

## Credential Model

### Owner Credential

- Full wallet authority
- May bypass policy
- Must never be used by the periodic vault-manager agent

### OWS API Token

- Scoped to one wallet for v1
- Attached to one or more policies
- The only credential the agent may use

### Broadcast Path

- Current implementation uses OWS for policy-gated signing and Base RPC for broadcast plus receipt verification.
- This does not widen secret access: the signing boundary remains inside OWS.
- When the OWS CLI exposes a documented `signAndSend` surface, the plugin should move broadcast into OWS as well.

## Policy Layers

### Declarative OWS Rules

Baseline controls:

- `allowed_chains = ["eip155:8453"]`
- optional `expires_at`

### Executable OWS Policy

Required for v1:

- restrict destination contracts to approved Morpho vault/spender addresses
- restrict method selectors to approved deposit/withdraw/approval flows
- block arbitrary ETH transfers
- block arbitrary ERC-20 approvals
- enforce optional turnover caps
- enforce optional concentration caps where feasible at policy time

## Logging Rules

- Do not log owner credentials, API tokens, private keys, mnemonics, or raw decrypted secret material.
- If logging command lines, redact secrets and token-like strings.
- If logging transaction plans, prefer summarized transaction metadata over full sensitive payload dumps unless debugging is explicitly enabled.

## Storage Rules

- Do not commit secrets to the repo.
- Do not write owner credentials into OpenClaw prompts or workspace files.
- API tokens should be stored via OpenClaw secret or env-backed configuration, not plaintext profile JSON.
- Profile files may contain public addresses, wallet IDs, vault allowlists, thresholds, and cron metadata.

## Execution Guardrails

- `scripts/rebalance/live-run` must refuse to execute unless an explicit arming control is present.
- Configure flows should default to dry-run validation before first live execution.
- All transaction execution wrappers must check:
  - chain
  - asset scope
  - simulation result
  - policy result
  - final receipt verification after broadcast

## Review Checklist

Every write-path change should be reviewed against these questions:

1. Does any new code handle sensitive material directly?
2. Can this path bypass OWS policy enforcement?
3. Can this path produce a live transaction after a failed simulation?
4. Can this path approve an unapproved spender?
5. Can this path operate on a non-Base chain or non-USDC asset?
6. Is the failure mode explicit and visible to the operator?

If any answer is "yes", the change is blocked until the architecture and security docs are updated and the guardrail is encoded mechanically.
