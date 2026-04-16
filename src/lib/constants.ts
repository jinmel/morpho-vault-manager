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

    maxTurnoverUsd: 5000,
    minimumVaultTvlUsd: 5_000_000,
    rewardPreference: "ignore",
    scoreWeights: {
      apy: 0.6,
      tvl: 0.8,
      fee: 0.8,
      rewardsPenalty: 0.5
    }
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "Optimize for yield while keeping concentration moderate.",
    maxVaults: 3,
    maxSingleVaultPct: 0.5,

    maxTurnoverUsd: 10_000,
    minimumVaultTvlUsd: 2_500_000,
    rewardPreference: "neutral",
    scoreWeights: {
      apy: 1.0,
      tvl: 0.5,
      fee: 0.6,
      rewardsPenalty: 0.0
    }
  },
  aggressive: {
    id: "aggressive",
    label: "Aggressive",
    description: "Maximize yield with higher turnover and concentration.",
    maxVaults: 4,
    maxSingleVaultPct: 0.7,

    maxTurnoverUsd: 25_000,
    minimumVaultTvlUsd: 1_000_000,
    rewardPreference: "include",
    scoreWeights: {
      apy: 1.4,
      tvl: 0.3,
      fee: 0.4,
      rewardsPenalty: 0.0
    }
  }
};
