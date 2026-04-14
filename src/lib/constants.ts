import type { RiskPreset } from "./types.js";

export const BASE_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const BASE_CHAIN_ID = "eip155:8453";
export const USDC_DECIMALS = 6;
export const MIN_ACTION_USDC = 1n * 10n ** 6n;

export const RISK_PRESETS: Record<RiskPreset["id"], RiskPreset> = {
  conservative: {
    id: "conservative",
    label: "Conservative",
    description: "Favor established vaults and lower turnover.",
    maxVaults: 2,
    maxSingleVaultPct: 0.6,
    rebalanceDriftPct: 0.1,
    maxTurnoverUsd: 5000,
    cashBufferUsd: 250,
    minimumVaultTvlUsd: 5_000_000,
    rewardPreference: "ignore"
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "Optimize for yield while keeping concentration moderate.",
    maxVaults: 3,
    maxSingleVaultPct: 0.5,
    rebalanceDriftPct: 0.075,
    maxTurnoverUsd: 10_000,
    cashBufferUsd: 100,
    minimumVaultTvlUsd: 2_500_000,
    rewardPreference: "neutral"
  },
  aggressive: {
    id: "aggressive",
    label: "Aggressive",
    description: "Move faster and accept tighter drift bounds.",
    maxVaults: 4,
    maxSingleVaultPct: 0.7,
    rebalanceDriftPct: 0.05,
    maxTurnoverUsd: 25_000,
    cashBufferUsd: 50,
    minimumVaultTvlUsd: 1_000_000,
    rewardPreference: "include"
  }
};
