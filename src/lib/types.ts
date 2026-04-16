import type { TokenSource } from "./secrets.js";

export type RiskProfileId = "conservative" | "balanced" | "aggressive";

export type VaultManagerSettings = {
  dataRoot: string;
  workspaceRoot: string;
  defaultProfilePath: string;
  owsCommand: string;
  openclawCommand: string;
  morphoCliCommand: string;
  morphoCliArgsPrefix: string[];
  baseRpcUrl?: string;
  defaultChain: "base";
  defaultCron: string;
  defaultTimezone: string;
  defaultDeliveryMode: "announce" | "none";
  defaultDeliveryChannel?: string;
  defaultDeliveryTo?: string;
  defaultDeliveryAccountId?: string;
  defaultTokenEnvVar: string;
  defaultTokenSource: TokenSource;
  baseAgentId: string;
  baseCronName: string;
  dryRunByDefault: boolean;
};

export type RiskPreset = {
  id: RiskProfileId;
  label: string;
  description: string;
  maxVaults: number;
  maxSingleVaultPct: number;
  rebalanceDriftPct: number;
  maxTurnoverUsd: number;
  cashBufferUsd: number;
  minimumVaultTvlUsd: number;
  rewardPreference: "ignore" | "neutral" | "include";
  scoreWeights: {
    apy: number;
    tvl: number;
    fee: number;
    rewardsPenalty: number;
  };
};

export type VaultManagerProfile = {
  profileId: string;
  chain: "base";
  walletRef: string;
  walletAddress: string;
  walletMode: "created" | "existing";
  riskProfile: RiskProfileId;
  tokenEnvVar: string;
  tokenSource?: TokenSource;
  usdcAddress: string;
  agentId: string;
  workspaceDir: string;
  cronJobId?: string;
  cronJobName: string;
  cronExpression: string;
  timezone: string;
  notifications: "announce" | "none";
  deliveryChannel?: string;
  deliveryTo?: string;
  deliveryAccountId?: string;
  cronEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  notes?: string;
  riskPreset: RiskPreset;
  modelPreference?: string;
  armedForLiveExecution?: boolean;
  lastFundedCheckAt?: string;
  lastFundedUsdc?: string;
  lastValidationRun?: {
    runId: string;
    status: string;
    receiptPath: string;
    createdAt: string;
  };
};

export type ConfigureResult = {
  profile: VaultManagerProfile;
  profilePath: string;
  createdAgent: boolean;
  createdCron: boolean;
};

export type CliLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};
