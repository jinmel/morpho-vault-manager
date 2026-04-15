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
  version?: string;
  asset: {
    address: string;
    symbol: string;
    decimals?: number;
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
    decimals?: number;
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
  description: string;
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
  preview?: Record<string, unknown>;
  analysisContext?: Record<string, unknown>;
};

export type MorphoSimulationResponse = {
  chain: string;
  allSucceeded?: boolean;
  totalGasUsed?: string;
  executionResults?: Array<Record<string, unknown>>;
  outcome?: Record<string, unknown>;
  warnings?: MorphoPreparedWarning[];
};

function trimJsonLike(text: string): string {
  return text.trim();
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
  const result = await runCommand(settings.morphoCliCommand, [
    ...settings.morphoCliArgsPrefix,
    ...args
  ]);

  if (result.code !== 0) {
    throw morphoError(result.stdout, result.stderr, `morpho command failed: ${args.join(" ")}`);
  }

  const stdout = trimJsonLike(result.stdout);
  try {
    const parsed = JSON.parse(stdout) as T & MorphoCommandErrorShape;
    if (parsed && typeof parsed === "object") {
      const errorShape = parsed as MorphoCommandErrorShape;
      if (typeof errorShape.error === "string" && typeof errorShape.message === "string") {
        throw new Error(errorShape.message || errorShape.error);
      }
    }
    return parsed as T;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        `Failed to parse morpho-cli JSON for "${args.join(" ")}": ${error.message}\n${stdout}`
      );
    }
    throw error;
  }
}

export async function runMorphoHealthCheck(settings: VaultManagerSettings): Promise<boolean> {
  const result = await runCommand(settings.morphoCliCommand, [
    ...settings.morphoCliArgsPrefix,
    "health-check"
  ]);
  return result.code === 0;
}

function normalizeVaultShape(raw: Record<string, unknown>): MorphoVaultDetail {
  const asset = (raw.asset ?? {}) as Record<string, unknown>;
  const tvl = raw.tvl;
  const tvlUsd = typeof raw.tvlUsd === "string" ? raw.tvlUsd : String(raw.tvlUsd ?? "0");

  const tvlBlock: MorphoVaultSummary["tvl"] =
    tvl && typeof tvl === "object"
      ? {
          symbol: String((tvl as Record<string, unknown>).symbol ?? asset.symbol ?? ""),
          value: String((tvl as Record<string, unknown>).value ?? "")
        }
      : {
          symbol: String(asset.symbol ?? ""),
          value: typeof tvl === "string" ? tvl : String(tvl ?? "0")
        };

  return {
    address: getAddress(String(raw.address)),
    chain: String(raw.chain ?? "base"),
    name: String(raw.name ?? ""),
    version: raw.version ? String(raw.version) : undefined,
    asset: {
      address: getAddress(String(asset.address)),
      symbol: String(asset.symbol ?? ""),
      decimals: typeof asset.decimals === "number" ? asset.decimals : undefined
    },
    apyPct: typeof raw.apyPct === "string" ? raw.apyPct : String(raw.apyPct ?? "0"),
    feePct: typeof raw.feePct === "string" ? raw.feePct : String(raw.feePct ?? "0"),
    tvl: tvlBlock,
    tvlUsd,
    allocations: Array.isArray(raw.allocations)
      ? (raw.allocations as Array<Record<string, unknown>>)
      : undefined
  };
}

export async function queryMorphoVaults(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  assetSymbol?: string
): Promise<MorphoVaultDetail[]> {
  const response = await runMorphoJsonCommand<Record<string, unknown>>(settings, [
    "query-vaults",
    "--chain",
    chain
  ]);
  const rawList =
    Array.isArray(response) ? response : Array.isArray(response?.vaults) ? (response.vaults as Array<Record<string, unknown>>) : [];
  const vaults = rawList
    .filter((raw) => raw && typeof raw === "object")
    .map((raw) => normalizeVaultShape(raw as Record<string, unknown>));
  if (assetSymbol) {
    return vaults.filter((vault) => vault.asset.symbol === assetSymbol);
  }
  return vaults;
}

export async function getMorphoVault(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  address: string
): Promise<MorphoVaultDetail> {
  const response = await runMorphoJsonCommand<Record<string, unknown>>(settings, [
    "get-vault",
    "--chain",
    chain,
    "--address",
    getAddress(address)
  ]);

  const vaultPayload =
    response && typeof response.vault === "object" && response.vault !== null
      ? (response.vault as Record<string, unknown>)
      : response;

  return normalizeVaultShape(vaultPayload);
}

function normalizeVaultPosition(raw: Record<string, unknown>): MorphoVaultPosition | null {
  const vaultRaw =
    (raw.vault as Record<string, unknown> | undefined) ??
    (raw.vaultInfo as Record<string, unknown> | undefined);
  const vaultAddress =
    typeof raw.vaultAddress === "string"
      ? raw.vaultAddress
      : typeof vaultRaw?.address === "string"
      ? String(vaultRaw.address)
      : null;
  if (!vaultAddress) return null;

  const assetRaw = (vaultRaw?.asset ?? raw.asset ?? {}) as Record<string, unknown>;

  const suppliedValue =
    typeof raw.suppliedAmount === "object" && raw.suppliedAmount !== null
      ? String((raw.suppliedAmount as Record<string, unknown>).value ?? "0")
      : typeof raw.supplied === "object" && raw.supplied !== null
      ? String((raw.supplied as Record<string, unknown>).value ?? "0")
      : typeof raw.supplyAssets === "string"
      ? String(raw.supplyAssets)
      : "0";

  const suppliedUsd =
    typeof raw.suppliedUsd === "string"
      ? raw.suppliedUsd
      : typeof raw.supplyAssetsUsd === "string"
      ? raw.supplyAssetsUsd
      : "0";

  return {
    vault: {
      address: getAddress(vaultAddress),
      name: String(vaultRaw?.name ?? ""),
      version: String(vaultRaw?.version ?? ""),
      asset: {
        address: assetRaw.address ? getAddress(String(assetRaw.address)) : "",
        symbol: String(assetRaw.symbol ?? "")
      }
    },
    supplied: {
      symbol: String(assetRaw.symbol ?? ""),
      value: suppliedValue
    },
    suppliedUsd
  };
}

export async function getMorphoPositions(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  userAddress: string
): Promise<MorphoPositionsResponse> {
  const response = await runMorphoJsonCommand<Record<string, unknown>>(settings, [
    "get-positions",
    "--chain",
    chain,
    "--user-address",
    getAddress(userAddress)
  ]);

  const rawPositions = Array.isArray(response.positions)
    ? (response.positions as Array<Record<string, unknown>>)
    : Array.isArray(response.vaultPositions)
    ? (response.vaultPositions as Array<Record<string, unknown>>)
    : [];

  const vaultPositions = rawPositions
    .map((entry) => normalizeVaultPosition(entry))
    .filter((position): position is MorphoVaultPosition => position !== null);

  const marketPositions = Array.isArray(response.marketPositions)
    ? (response.marketPositions as Array<Record<string, unknown>>)
    : [];

  return {
    chain: String(response.chain ?? chain),
    userAddress: getAddress(String(response.userAddress ?? userAddress)),
    totals: {
      vaultCount: vaultPositions.length,
      marketCount: marketPositions.length,
      suppliedUsd: vaultPositions
        .reduce((acc, position) => acc + Number(position.suppliedUsd || "0"), 0)
        .toString(),
      borrowedUsd: "0",
      collateralUsd: "0",
      netWorthUsd: "0"
    },
    vaultPositions,
    marketPositions
  };
}

export async function getMorphoTokenBalance(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  tokenAddress: string,
  userAddress: string
): Promise<MorphoTokenBalanceResponse> {
  const response = await runMorphoJsonCommand<Record<string, unknown>>(settings, [
    "get-token-balance",
    "--chain",
    chain,
    "--token-address",
    getAddress(tokenAddress),
    "--user-address",
    getAddress(userAddress)
  ]);

  const asset = (response.asset ?? {}) as Record<string, unknown>;
  const rawBalance = response.balance;
  const balance: MorphoTokenBalanceResponse["balance"] =
    typeof rawBalance === "string" || typeof rawBalance === "number"
      ? {
          symbol: String(asset.symbol ?? ""),
          value: String(rawBalance)
        }
      : rawBalance && typeof rawBalance === "object"
      ? {
          symbol: String(
            (rawBalance as Record<string, unknown>).symbol ?? asset.symbol ?? ""
          ),
          value: String((rawBalance as Record<string, unknown>).value ?? "0")
        }
      : { symbol: String(asset.symbol ?? ""), value: "0" };

  const erc20 = (response.erc20Allowances ?? {}) as Record<string, unknown>;
  const allowanceBlock = (symbol: string, value: unknown) => ({
    symbol,
    value: typeof value === "string" ? value : value === undefined || value === null ? "0" : String(value)
  });

  return {
    chain: String(response.chain ?? chain),
    userAddress: getAddress(String(response.userAddress ?? userAddress)),
    asset: {
      address: getAddress(String(asset.address ?? tokenAddress)),
      symbol: String(asset.symbol ?? ""),
      decimals: typeof asset.decimals === "number" ? asset.decimals : undefined
    },
    balance,
    morphoAllowance: allowanceBlock(String(asset.symbol ?? ""), erc20.morpho),
    bundlerAllowance: allowanceBlock(String(asset.symbol ?? ""), erc20.bundler),
    permit2Allowance: allowanceBlock(String(asset.symbol ?? ""), erc20.permit2),
    needsApprovalForMorpho: (erc20.morpho ?? "0") === "0",
    needsApprovalForBundler: (erc20.bundler ?? "0") === "0"
  };
}

function normalizePreparedTransactions(raw: unknown): MorphoUnsignedTransaction[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const description =
      typeof record.description === "string"
        ? record.description
        : `morpho transaction ${index}`;
    return {
      to: getAddress(String(record.to)),
      data: String(record.data ?? "0x") as `0x${string}`,
      value: typeof record.value === "string" ? record.value : String(record.value ?? "0"),
      chainId: typeof record.chainId === "string" ? record.chainId : String(record.chainId ?? ""),
      description
    };
  });
}

function normalizeWarnings(raw: unknown): MorphoPreparedWarning[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return {
        level: String(record.level ?? "info"),
        message: String(record.message ?? ""),
        code: typeof record.code === "string" ? record.code : undefined
      };
    })
    .filter((warning) => warning.message.length > 0);
}

async function simulatePreparedTransactions(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  from: string,
  transactions: MorphoUnsignedTransaction[],
  analysisContext: Record<string, unknown> | undefined
): Promise<MorphoSimulationResponse> {
  if (transactions.length === 0) {
    return { chain, allSucceeded: true, executionResults: [], warnings: [] };
  }

  const args = [
    "simulate-transactions",
    "--chain",
    chain,
    "--from",
    getAddress(from),
    "--transactions",
    JSON.stringify(transactions)
  ];
  if (analysisContext) {
    args.push("--analysis-context", JSON.stringify(analysisContext));
  }

  const result = await runCommand(settings.morphoCliCommand, [
    ...settings.morphoCliArgsPrefix,
    ...args
  ]);

  if (result.code !== 0) {
    const parsed = tryParseErrorShape(result.stdout) ?? tryParseErrorShape(result.stderr);
    return {
      chain,
      allSucceeded: false,
      executionResults: [],
      warnings: [
        {
          level: "error",
          message: parsed ?? result.stderr.trim() ?? "morpho simulate-transactions failed",
          code: "SIMULATE_INVOCATION_FAILED"
        }
      ]
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as MorphoSimulationResponse & {
      error?: string;
      message?: string;
    };
    if (typeof parsed.error === "string") {
      return {
        chain,
        allSucceeded: false,
        executionResults: [],
        warnings: [
          {
            level: "error",
            message: parsed.message ?? parsed.error,
            code: "SIMULATE_ERROR"
          }
        ]
      };
    }
    return {
      chain: String(parsed.chain ?? chain),
      allSucceeded: typeof parsed.allSucceeded === "boolean" ? parsed.allSucceeded : false,
      totalGasUsed: typeof parsed.totalGasUsed === "string" ? parsed.totalGasUsed : undefined,
      executionResults: Array.isArray(parsed.executionResults) ? parsed.executionResults : [],
      outcome: (parsed as MorphoSimulationResponse).outcome,
      warnings: normalizeWarnings(parsed.warnings)
    };
  } catch (error) {
    return {
      chain,
      allSucceeded: false,
      executionResults: [],
      warnings: [
        {
          level: "error",
          message: `Failed to parse simulate-transactions output: ${(error as Error).message}`,
          code: "SIMULATE_PARSE_ERROR"
        }
      ]
    };
  }
}

async function runPrepareWithSimulation(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  userAddress: string,
  rawArgs: string[]
): Promise<MorphoPreparedOperation> {
  const response = await runMorphoJsonCommand<Record<string, unknown>>(settings, rawArgs);

  const transactions = normalizePreparedTransactions(response.transactions);
  const warnings = normalizeWarnings(response.warnings);
  const analysisContext =
    response.analysisContext && typeof response.analysisContext === "object"
      ? (response.analysisContext as Record<string, unknown>)
      : undefined;

  const simulation = await simulatePreparedTransactions(
    settings,
    chain,
    userAddress,
    transactions,
    analysisContext
  );

  const combinedWarnings = [...warnings, ...(simulation.warnings ?? [])];
  const hasSimulationError = combinedWarnings.some((warning) => warning.level === "error");

  return {
    operation: typeof response.operation === "string" ? response.operation : "morpho-operation",
    chain: String(response.chain ?? chain),
    summary: typeof response.summary === "string" ? response.summary : "",
    requirements: Array.isArray(response.requirements)
      ? (response.requirements as Array<Record<string, unknown>>)
      : undefined,
    transactions,
    simulated: true,
    simulationOk: simulation.allSucceeded === true && !hasSimulationError,
    totalGasUsed: simulation.totalGasUsed,
    outcome: simulation.outcome,
    warnings: combinedWarnings,
    preview:
      response.preview && typeof response.preview === "object"
        ? (response.preview as Record<string, unknown>)
        : undefined,
    analysisContext
  };
}

export async function prepareMorphoDeposit(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  vaultAddress: string,
  userAddress: string,
  amount: string
): Promise<MorphoPreparedOperation> {
  return runPrepareWithSimulation(settings, chain, userAddress, [
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
}

export async function prepareMorphoWithdraw(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  vaultAddress: string,
  userAddress: string,
  amount: string
): Promise<MorphoPreparedOperation> {
  return runPrepareWithSimulation(settings, chain, userAddress, [
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
}

export async function simulateMorphoTransactions(
  settings: VaultManagerSettings,
  chain: "base" | "ethereum",
  from: string,
  transactions: MorphoUnsignedTransaction[]
): Promise<MorphoSimulationResponse> {
  return simulatePreparedTransactions(settings, chain, from, transactions, undefined);
}
