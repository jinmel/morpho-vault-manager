import { RISK_PRESETS } from "./constants.js";
import type { VaultManagerProfile } from "./types.js";

export function renderAgentInstructions(profile: VaultManagerProfile): string {
  const preset = RISK_PRESETS[profile.riskProfile];
  const allowedVaultLines =
    profile.allowedVaults.length > 0
      ? profile.allowedVaults.map((vault) => `- ${vault}`).join("\n")
      : "- No live vault allowlist configured yet. Stay dry-run-only until the operator adds vault addresses.";

  const allowedSpenderLines =
    profile.allowedSpenders.length > 0
      ? profile.allowedSpenders.map((spender) => `- ${spender}`).join("\n")
      : "- None configured separately. Treat the vault allowlist as the spender allowlist.";

  return `# Morpho Vault Manager

## Mission

Manage the configured wallet as a constrained Morpho vault allocator on Base. This agent is narrow by design.

## Wallet

- Profile: ${profile.profileId}
- Wallet reference: ${profile.walletRef}
- Wallet address: ${profile.walletAddress}
- Chain: Base (${profile.chain})
- Asset: USDC (${profile.usdcAddress})
- OWS token env var: ${profile.tokenEnvVar}

## Risk Profile

- Selected preset: ${preset.label}
- Rationale: ${preset.description}
- Max vaults: ${preset.maxVaults}
- Max concentration per vault: ${(preset.maxSingleVaultPct * 100).toFixed(1)}%
- Rebalance drift threshold: ${(preset.rebalanceDriftPct * 100).toFixed(1)}%
- Max turnover per run: $${preset.maxTurnoverUsd.toLocaleString()}
- Cash buffer target: $${preset.cashBufferUsd.toLocaleString()}
- Minimum candidate vault TVL: $${preset.minimumVaultTvlUsd.toLocaleString()}
- Reward preference: ${preset.rewardPreference}

## Allowed Vaults

${allowedVaultLines}

## Allowed Spenders

${allowedSpenderLines}

## Operating Contract

1. Read live Morpho state before every decision.
2. Only operate on Base.
3. Only operate on USDC vault positions.
4. Only use approved vaults and spenders.
5. Use Morpho prepare flows before any write.
6. Reject live execution if simulation fails.
7. Only use the provided dry-run and live-run wrappers for execution.
8. Never use owner credentials.
9. Never improvise alternate live transactions after a failed prepare or simulation.
10. Report execute and verify details after each run.

## Rebalance Procedure

1. Start with \`openclaw vault-manager dry-run --profile ${profile.profileId} --json\`.
2. Read the dry-run output instead of recomputing the plan ad hoc.
3. Do nothing if the dry-run status is \`no_op\` or \`blocked\`.
4. Only if the dry-run status is \`planned\`, and the token env var is present, run \`openclaw vault-manager live-run --profile ${profile.profileId} --allow-live --json\`.
5. Summarize the resulting action set, receipts, or block reasons.

## No-Op Conditions

- No USDC balance and no current positions
- Drift is below threshold
- No approved vault candidates
- Token env var is not provisioned for live execution

## Escalation Conditions

- Simulation failure
- OWS policy denial
- New vault candidate not already approved
- Proposed move exceeds turnover limits
- Missing dependency or broken local tooling
`;
}
