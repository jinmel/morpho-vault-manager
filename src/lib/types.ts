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
  defaultTokenEnvVar: string;
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
};

export type VaultManagerProfile = {
  profileId: string;
  chain: "base";
  walletRef: string;
  walletAddress: string;
  walletMode: "created" | "existing";
  riskProfile: RiskProfileId;
  allowedVaults: string[];
  allowedSpenders: string[];
  tokenEnvVar: string;
  usdcAddress: string;
  policyId: string;
  policyFile: string;
  policyExecutable: string;
  agentId: string;
  workspaceDir: string;
  cronJobId?: string;
  cronJobName: string;
  cronExpression: string;
  timezone: string;
  notifications: "announce" | "none";
  cronEnabled: boolean;
  createdAt: string;
  updatedAt: string;
  notes?: string;
  riskPreset: RiskPreset;
};

export type ConfigureResult = {
  profile: VaultManagerProfile;
  profilePath: string;
  createdPolicy: boolean;
  createdAgent: boolean;
  createdCron: boolean;
};

export type CliLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
  error?: (message: string) => void;
};
