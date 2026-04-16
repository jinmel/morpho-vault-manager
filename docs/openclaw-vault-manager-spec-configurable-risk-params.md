# OpenClaw Morpho Vault Manager Plugin Spec
## Configurable Drift Rule and Minimum Position Size

Date: 2026-04-16

Status: Addendum to [docs/openclaw-vault-manager-spec.md](./openclaw-vault-manager-spec.md)

Purpose: make `rebalanceDriftPct` and `minimumPositionUsd` operator-configurable during the `configure` and `reconfigure` subcommands, instead of locking them to fixed preset values.

## Motivation

The three risk presets (conservative, balanced, aggressive) currently hardcode the drift threshold and minimum position size. Operators who understand their portfolio may want to tighten or loosen these parameters without switching to an entirely different risk preset.

For example:
- An operator running $500k in a balanced profile may want a tighter 3% drift threshold to rebalance more frequently, but still prefer the balanced scoring weights.
- An operator with a small test portfolio may want to lower the minimum position size below the preset default.

## Current Behavior

1. The operator selects a risk preset (conservative / balanced / aggressive).
2. The preset is cloned onto the profile as `riskPreset`, including `rebalanceDriftPct` and `minimumPositionUsd`.
3. The wizard displays the machine-readable config, then moves on.
4. There is no opportunity to override individual parameters.

## Proposed Behavior

### Step 3a. Optional Risk Parameter Customization

After the operator selects a risk preset and sees the machine-readable config, the wizard should offer an **optional customization step**:

```
? Customize risk parameters for this profile? (advanced)
  ○ No — use the preset defaults (recommended)
  ○ Yes — adjust drift threshold and minimum position size
```

If the operator selects "Yes", prompt for each configurable parameter:

#### Drift threshold

```
? Rebalance drift threshold (%)
  Current preset default: 7.5%
  ▌ 7.5
```

- Input is a percentage (e.g., `5` means 5%).
- Stored as a decimal on the profile (`0.05`).
- Validation: must be between 1% and 50% inclusive.
- Default: the preset value.

#### Minimum position size

```
? Minimum position size (USD)
  Current preset default: $50
  ▌ 50
```

- Input is a USD amount.
- Validation: must be between $1 and $10,000 inclusive.
- Default: the preset value.

### Reconfigure

The `reconfigure` subcommand already re-runs the full configure flow. The customization step should appear there too, pre-populated with the profile's current values (which may differ from the preset defaults if the operator previously customized them).

### Profile Storage

The operator's overrides are written directly onto the `riskPreset` object on the profile. No separate "overrides" layer is needed — the profile's `riskPreset` is already the effective config, and the preset `id` field records which base preset was used.

Example profile after customization:

```json
{
  "riskProfile": "balanced",
  "riskPreset": {
    "id": "balanced",
    "rebalanceDriftPct": 0.03,
    "minimumPositionUsd": 25,
    "maxVaults": 3,
    "maxSingleVaultPct": 0.5,
    "maxTurnoverUsd": 10000,
    "minimumVaultTvlUsd": 2500000,
    "rewardPreference": "neutral",
    "scoreWeights": { "apy": 1.0, "tvl": 0.5, "fee": 0.6, "rewardsPenalty": 0.0 }
  }
}
```

### AGENTS.md

The generated AGENTS.md already reads from `profile.riskPreset`, so customized values will automatically appear in the agent's standing orders. No template changes needed.

### Status Display

The `status` command should indicate when risk parameters differ from the base preset defaults. For example:

```
Risk profile: balanced
  Drift threshold: 3.0% (preset default: 7.5%)
  Minimum position: $25 (preset default: $50)
```

If values match the preset, no annotation is needed.

## Validation Rules

| Parameter | Min | Max | Type |
|-----------|-----|-----|------|
| `rebalanceDriftPct` | 0.01 (1%) | 0.50 (50%) | decimal |
| `minimumPositionUsd` | 1 | 10000 | integer USD |

Values outside these ranges should be rejected with a clear error message.

## Eval Coverage

Add one eval scenario:

- **CFG-006**: Verify that customized drift and minimum position values are stored on the profile's `riskPreset` and differ from the base preset defaults when overridden.

## Scope

This addendum only covers `rebalanceDriftPct` and `minimumPositionUsd`. Other risk parameters (`maxVaults`, `maxSingleVaultPct`, `maxTurnoverUsd`, `scoreWeights`) remain locked to preset values for v1. Extending customization to additional parameters is a natural follow-up but should be scoped separately.
