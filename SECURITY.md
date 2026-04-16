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

## Morpho MCP Registration

Configure optionally registers the hosted Morpho MCP server (`https://mcp.morpho.org`) into OpenClaw gateway-wide config under the name `morpho`. This is orthogonal to the rebalance runtime trust boundary but widens the free-form chat surface, so its trade-offs are part of the security model:

- The MCP server exposes read tools (vaults, markets, positions, docs) and `prepare_*` tools that return unsigned transactions. The MCP endpoint cannot sign or broadcast.
- Prepared transactions from the MCP server only become live writes if an operator signs them through OWS.
- The periodic rebalance agent does not invoke the MCP server. It uses `morpho-cli` directly and runs under the narrow AGENTS.md contract. MCP registration does not change its execution path.
- The MCP server bypasses the plugin's own `read → prepare → simulate → sign → verify` pipeline for any free-form chat that the operator may later run.
- MCP registration is a user-gated confirmation step in configure and is idempotent: existing `morpho` entries are preserved, not overwritten.
- To remove the MCP registration, run `openclaw mcp unset morpho`.

Any future expansion of what the Morpho MCP server can do (e.g. server-side signing) must re-evaluate whether this plugin should continue registering it automatically.

## Logging Rules

- Do not log owner credentials, API tokens, private keys, mnemonics, or raw decrypted secret material.
- If logging command lines, redact secrets and token-like strings.
- If logging transaction plans, prefer summarized transaction metadata over full sensitive payload dumps unless debugging is explicitly enabled.

## Storage Rules

- Do not commit secrets to the repo.
- Do not write owner credentials into OpenClaw prompts or workspace files.
- API tokens must be resolved through the configured token source (`env` or `file`), never hardcoded in profile JSON or plugin config.
- `file` sources are intended for mounted-secret setups (Docker/k8s/systemd EnvironmentFile). File contents are read at execution time and never copied into the profile.
- Profile files may contain public addresses, wallet IDs, thresholds, cron metadata, and the token source descriptor (kind + identifier), never the token value itself.
- The configure flow should emit the OWS API-key provisioning command and then accept only the resulting token source descriptor, not the raw token.

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
