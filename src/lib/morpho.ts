import { getAddress } from "viem";
import { runCommand } from "./shell.js";
import type { VaultManagerSettings } from "./types.js";

type MorphoCommandErrorShape = {
  error?: string;
  message?: string;
};

export type MorphoVaultSummary = {
  address: string;
  chain: string;
  name: string;
  version: string;
  asset: {
    address: string;
    symbol: string;
  };
  apyPct: string;
  feePct: string;
  tvl: {
    symbol: string;
    value: string;
  };
  tvlUsd: string;
};

export type MorphoVaultDetail = MorphoVaultSummary & {
  allocations?: Array<Record<string, unknown>>;
};

export type MorphoVaultPosition = {
  vault: {
    address: string;
    name: string;
    version: string;
    asset: {
      address: string;
      symbol: string;
    };
  };
  supplied: {
    symbol: string;
    value: string;
  };
  suppliedUsd: string;
};

export type MorphoPositionsResponse = {
  chain: string;
  userAddress: string;
  totals: {
    vaultCount: number;
    marketCount: number;
    suppliedUsd: string;
    borrowedUsd: string;
    collateralUsd: string;
    netWorthUsd: string;
  };
  vaultPositions: MorphoVaultPosition[];
  marketPositions: Array<Record<string, unknown>>;
};

export type MorphoTokenBalanceResponse = {
  chain: string;
  userAddress: string;
  asset: {
    address: string;
    symbol: string;
  };
  balance: {
    symbol: string;
    value: string;
  };
  morphoAllowance?: {
    symbol: string;
    value: string;
  };
  bundlerAllowance?: {
    symbol: string;
    value: string;
  };
  permit2Allowance?: {
    symbol: string;
    value: string;
  };
  needsApprovalForMorpho?: boolean;
  needsApprovalForBundler?: boolean;
};

export type MorphoUnsignedTransaction = {
  to: string;
  data: `0x${string}`;
  value: string;
  chainId: string;
  description?: string;
};

export type MorphoPreparedWarning = {
  level: string;
  message: string;
  code?: string;
};

export type MorphoPreparedOperation = {
  operation: string;
  chain: string;
  summary: string;
  requirements?: Array<Record<string, unknown>>;
  transactions: MorphoUnsignedTransaction[];
  simulated?: boolean;
  simulationOk?: boolean;
  totalGasUsed?: string;
  outcome?: Record<string, unknown>;
  warnings?: MorphoPreparedWarning[];
};

export type MorphoSimulationResponse = {
  chain: string;
  allSucceeded?: boolean;
  totalGasUsed?: string;
  results?: Array<Record<string, unknown>>;
  outcome?: Record<string, unknown>;
  warnings?: MorphoPreparedWarning[];
};

function trimJsonLike(text: string): string {
  const value = text.trim();
  return value;
}

function tryParseErrorShape(text: string): string | null {
  const value = trimJsonLike(text);
  if (!value) return null;

  try {
    const parsed = JSON.parse(value) as MorphoCommandErrorShape;
    if (typeof parsed.message === "string" && parsed.message.trim().length > 0) {
      return parsed.message.trim();
    }
    if (typeof parsed.error === "string" && parsed.error.trim().length > 0) {
      return parsed.error.trim();
    }
  } catch {
    return null;
  }

  return null;
}

function morphoError(stdout: string, stderr: string, fallback: string): Error {
  const parsed =
    tryParseErrorShape(stdout) ??
    tryParseErrorShape(stderr) ??
    (stderr.trim() || stdout.trim() || fallback);
  return new Error(parsed);
}

async function runMorphoJsonCommand<T>(
  settings: VaultManagerSettings,
  args: string[]
): Promise<T> {
  const result = await runCommand(settings.morphoCliCommand, [...settings.morphoCliArgsPrefix, ...args]);

  if (result.code !== 0) {
    throw morphoError(result.stdout, result.stderr, `morpho command failed: ${args.join(" ")}`);
  }

  const stdout = trimJsonLike(result.stdout);
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(
      `Failed to parse morpho-cli JSON for "${args.join(" ")}": ${(error as Error).message}\n${stdout}`
    );
  }
}

export async function runMorphoHealthCheck(settings: VaultManagerSettings): Promise<boolean> {
  const result = await runCommand(settings.morphoCliCommand, [
    ...settings.morphoCliArgsPrefix,
    "health-check"
  ]);
  return result.code === 0;
}

export async function getMorphoVault(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  address: string
): Promise<MorphoVaultDetail> {
  const vault = await runMorphoJsonCommand<MorphoVaultDetail>(settings, [
    "get-vault",
    "--chain",
    chain,
    "--address",
    getAddress(address)
  ]);

  return {
    ...vault,
    address: getAddress(vault.address),
    asset: {
      ...vault.asset,
      address: getAddress(vault.asset.address)
    }
  };
}

export async function getMorphoPositions(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  userAddress: string
): Promise<MorphoPositionsResponse> {
  const response = await runMorphoJsonCommand<MorphoPositionsResponse>(settings, [
    "get-positions",
    "--chain",
    chain,
    "--user-address",
    getAddress(userAddress)
  ]);

  return {
    ...response,
    userAddress: getAddress(response.userAddress),
    vaultPositions: response.vaultPositions.map((position) => ({
      ...position,
      vault: {
        ...position.vault,
        address: getAddress(position.vault.address),
        asset: {
          ...position.vault.asset,
          address: getAddress(position.vault.asset.address)
        }
      }
    }))
  };
}

export async function getMorphoTokenBalance(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  tokenAddress: string,
  userAddress: string
): Promise<MorphoTokenBalanceResponse> {
  const response = await runMorphoJsonCommand<MorphoTokenBalanceResponse>(settings, [
    "get-token-balance",
    "--chain",
    chain,
    "--token-address",
    getAddress(tokenAddress),
    "--user-address",
    getAddress(userAddress)
  ]);

  return {
    ...response,
    userAddress: getAddress(response.userAddress),
    asset: {
      ...response.asset,
      address: getAddress(response.asset.address)
    }
  };
}

export async function prepareMorphoDeposit(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  vaultAddress: string,
  userAddress: string,
  amount: string
): Promise<MorphoPreparedOperation> {
  const operation = await runMorphoJsonCommand<MorphoPreparedOperation>(settings, [
    "prepare-deposit",
    "--chain",
    chain,
    "--vault-address",
    getAddress(vaultAddress),
    "--user-address",
    getAddress(userAddress),
    "--amount",
    amount
  ]);

  return normalizePreparedOperation(operation);
}

export async function prepareMorphoWithdraw(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  vaultAddress: string,
  userAddress: string,
  amount: string
): Promise<MorphoPreparedOperation> {
  const operation = await runMorphoJsonCommand<MorphoPreparedOperation>(settings, [
    "prepare-withdraw",
    "--chain",
    chain,
    "--vault-address",
    getAddress(vaultAddress),
    "--user-address",
    getAddress(userAddress),
    "--amount",
    amount
  ]);

  return normalizePreparedOperation(operation);
}

export async function simulateMorphoTransactions(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  from: string,
  transactions: MorphoUnsignedTransaction[]
): Promise<MorphoSimulationResponse> {
  return runMorphoJsonCommand<MorphoSimulationResponse>(settings, [
    "simulate-transactions",
    "--chain",
    chain,
    "--from",
    getAddress(from),
    "--transactions",
    JSON.stringify(transactions)
  ]);
}

function normalizePreparedOperation(operation: MorphoPreparedOperation): MorphoPreparedOperation {
  return {
    ...operation,
    transactions: operation.transactions.map((transaction) => ({
      ...transaction,
      to: getAddress(transaction.to)
    })),
    warnings: operation.warnings ?? []
  };
}
