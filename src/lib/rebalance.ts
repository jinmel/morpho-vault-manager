import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createPublicClient,
  formatUnits,
  getAddress,
  http,
  parseSignature,
  parseTransaction,
  parseUnits,
  serializeTransaction
} from "viem";
import type { Address, Hex, TransactionSerializableEIP1559 } from "viem";
import { base } from "viem/chains";
import { MIN_ACTION_USDC, USDC_DECIMALS } from "./constants.js";
import { ensureDir, writeJsonFile } from "./fs.js";
import {
  getMorphoPositions,
  getMorphoTokenBalance,
  prepareMorphoDeposit,
  prepareMorphoWithdraw,
  queryMorphoVaults,
  type MorphoPositionsResponse,
  type MorphoPreparedOperation,
  type MorphoPreparedWarning,
  type MorphoTokenBalanceResponse,
  type MorphoUnsignedTransaction,
  type MorphoVaultDetail,
  type MorphoVaultPosition
} from "./morpho.js";
import { signTransactionWithOws } from "./ows.js";
import { loadProfile } from "./profile.js";
import { createRunLogger, runLogPathFor, type RunLogger } from "./run-logger.js";
import { describeTokenSource, resolveApiToken } from "./secrets.js";
import type { RiskPreset, VaultManagerProfile, VaultManagerSettings } from "./types.js";

export type RebalanceMode = "dry-run" | "live";

export type RebalanceStatus = "no_op" | "planned" | "executed" | "blocked";

export type RebalanceReadDeps = {
  queryVaults: () => Promise<MorphoVaultDetail[]>;
  getPositions: (walletAddress: string) => Promise<MorphoPositionsResponse>;
  getTokenBalance: (walletAddress: string) => Promise<MorphoTokenBalanceResponse>;
  prepareDeposit: (
    vaultAddress: string,
    walletAddress: string,
    amount: string
  ) => Promise<MorphoPreparedOperation>;
  prepareWithdraw: (
    vaultAddress: string,
    walletAddress: string,
    amount: string
  ) => Promise<MorphoPreparedOperation>;
};

function defaultReadDeps(settings: VaultManagerSettings, profile: VaultManagerProfile): RebalanceReadDeps {
  return {
    queryVaults: () => queryMorphoVaults(settings, profile.chain, "USDC"),
    getPositions: (walletAddress) => getMorphoPositions(settings, profile.chain, walletAddress),
    getTokenBalance: (walletAddress) =>
      getMorphoTokenBalance(settings, profile.chain, profile.usdcAddress, walletAddress),
    prepareDeposit: (vaultAddress, walletAddress, amount) =>
      prepareMorphoDeposit(settings, profile.chain, vaultAddress, walletAddress, amount),
    prepareWithdraw: (vaultAddress, walletAddress, amount) =>
      prepareMorphoWithdraw(settings, profile.chain, vaultAddress, walletAddress, amount)
  };
}

export type RebalanceAction = {
  kind: "deposit" | "withdraw";
  vaultAddress: string;
  vaultName: string;
  amountUsdc: string;
  currentUsdc: string;
  targetUsdc: string;
  clippedByTurnover: boolean;
};

export type RebalanceOperationResult = {
  kind: "deposit" | "withdraw";
  vaultAddress: string;
  vaultName: string;
  amountUsdc: string;
  summary?: string;
  simulationOk: boolean;
  warnings: MorphoPreparedWarning[];
  transactions: MorphoUnsignedTransaction[];
  error?: string;
};

export type ExecutedTransactionReceipt = {
  description: string;
  hash: string;
  status: "success";
  gasUsed: string;
  blockNumber: string;
};

export type RebalanceRunResult = {
  runId: string;
  mode: RebalanceMode;
  status: RebalanceStatus;
  profileId: string;
  createdAt: string;
  receiptPath: string;
  logPath: string;
  walletAddress: string;
  riskProfile: VaultManagerProfile["riskProfile"];
  tokenEnvVar: string;
  tokenSource: string;
  tokenReady: boolean;
  reasons: string[];
  warnings: string[];
  metrics: {
    idleUsdc: string;
    totalManagedUsdc: string;
    targetCashBufferUsdc: string;
    driftThresholdPct: string;
    maxObservedDriftPct: string;
    turnoverCapUsdc: string;
    totalPlannedTurnoverUsdc: string;
  };
  vaults: {
    selected: Array<{
      address: string;
      name: string;
      apyPct: string;
      feePct: string;
      tvlUsd: string;
      score: string;
      scoreBreakdown: {
        apyTerm: string;
        tvlTerm: string;
        feeTerm: string;
        rewardsPenaltyTerm: string;
      };
    }>;
    rejected: Array<{
      address: string;
      reason: string;
    }>;
  };
  allocations: Array<{
    vaultAddress: string;
    vaultName: string;
    currentUsdc: string;
    targetUsdc: string;
    diffUsdc: string;
    currentPct: string;
    targetPct: string;
  }>;
  actions: RebalanceAction[];
  operations: RebalanceOperationResult[];
  execution: {
    rpcUrl?: string;
    transactions: ExecutedTransactionReceipt[];
  };
};

type CandidateVault = {
  address: string;
  name: string;
  apyPct: number;
  apyPctRaw: string;
  tvlUsd: number;
  tvlUsdRaw: string;
  feePct: number;
  feePctRaw: string;
};

type RankedCandidate = CandidateVault & {
  score: number;
  scoreBreakdown: {
    apyTerm: number;
    tvlTerm: number;
    feeTerm: number;
    rewardsPenaltyTerm: number;
  };
};

type ActionDraft = {
  kind: "deposit" | "withdraw";
  vaultAddress: string;
  vaultName: string;
  currentAmount: bigint;
  targetAmount: bigint;
  amount: bigint;
  clippedByTurnover: boolean;
};

function toUsdcUnits(value: string): bigint {
  return parseUnits(value, USDC_DECIMALS);
}

function formatUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}

function bigintAbs(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function percentString(value: number): string {
  return value.toFixed(2);
}

function ratioPctString(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) return "0.00";
  return ((Number(numerator) / Number(denominator)) * 100).toFixed(2);
}

function scaleAmount(value: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  return (value * numerator) / denominator;
}

function capBps(maxSingleVaultPct: number): bigint {
  return BigInt(Math.round(maxSingleVaultPct * 10_000));
}

function targetCashBuffer(totalManaged: bigint, preset: RiskPreset): bigint {
  const configured = parseUnits(String(preset.cashBufferUsd), USDC_DECIMALS);
  return configured > totalManaged ? totalManaged : configured;
}

function describePosition(position: MorphoVaultPosition): string {
  const amount = position.supplied?.value ?? "0";
  const name = position.vault?.name?.trim() || position.vault.address;
  return `${name} (${amount} USDC)`;
}

function collectUnsupportedPositionReasons(params: {
  positionsResponse: MorphoPositionsResponse;
  candidateVaultSet: Set<string>;
}): {
  blockers: string[];
  nonUsdcVaultRejections: Array<{ address: string; reason: string }>;
  supportedVaultPositions: MorphoVaultPosition[];
} {
  const blockers: string[] = [];
  const nonUsdcVaultRejections: Array<{ address: string; reason: string }> = [];
  const supportedVaultPositions: MorphoVaultPosition[] = [];
  const nonUsdcVaultPositions: MorphoVaultPosition[] = [];

  for (const position of params.positionsResponse.vaultPositions) {
    const address = getAddress(position.vault.address);
    const assetSymbol = position.vault.asset?.symbol;
    if (assetSymbol && assetSymbol !== "USDC") {
      nonUsdcVaultPositions.push(position);
      nonUsdcVaultRejections.push({
        address,
        reason: `Vault position ${describePosition(position)} is not a USDC vault (asset ${assetSymbol}).`
      });
      continue;
    }
    supportedVaultPositions.push(position);
  }

  if (nonUsdcVaultPositions.length > 0) {
    blockers.push(
      `Found ${nonUsdcVaultPositions.length} non-USDC Morpho vault position(s); this agent only manages USDC vault positions: ${nonUsdcVaultPositions
        .map(describePosition)
        .join(", ")}.`
    );
  }

  if ((params.positionsResponse.marketPositions?.length ?? 0) > 0) {
    blockers.push(
      `Found ${params.positionsResponse.marketPositions.length} non-vault Morpho market position(s); this agent only manages USDC vault positions.`
    );
  }

  return {
    blockers,
    nonUsdcVaultRejections,
    supportedVaultPositions
  };
}

function topVaultSetChangedMaterially(params: {
  selected: RankedCandidate[];
  positions: MorphoVaultPosition[];
}): { changed: boolean; detail?: string } {
  const selectedAddresses = new Set(params.selected.map((vault) => vault.address));
  const changedPositions = params.positions.filter((position) => {
    const address = getAddress(position.vault.address);
    const supplied = toUsdcUnits(position.supplied.value);
    return supplied >= MIN_ACTION_USDC && !selectedAddresses.has(address);
  });

  if (changedPositions.length === 0) {
    return { changed: false };
  }

  return {
    changed: true,
    detail: changedPositions.map(describePosition).join(", ")
  };
}

function buildRankedCandidates(vaults: MorphoVaultDetail[], preset: RiskPreset): {
  ranked: RankedCandidate[];
  rejected: Array<{ address: string; reason: string }>;
} {
  const rejected: Array<{ address: string; reason: string }> = [];
  const eligible: CandidateVault[] = [];

  for (const vault of vaults) {
    if (vault.asset.symbol !== "USDC") {
      rejected.push({ address: vault.address, reason: `Unsupported asset ${vault.asset.symbol}.` });
      continue;
    }

    const tvlUsd = Number(vault.tvlUsd);
    if (!Number.isFinite(tvlUsd) || tvlUsd < preset.minimumVaultTvlUsd) {
      rejected.push({
        address: vault.address,
        reason: `TVL ${vault.tvlUsd} is below minimum ${preset.minimumVaultTvlUsd}.`
      });
      continue;
    }

    const apyPct = Number(vault.apyPct);
    const feePct = Number(vault.feePct);

    eligible.push({
      address: vault.address,
      name: vault.name,
      apyPct: Number.isFinite(apyPct) ? apyPct : 0,
      apyPctRaw: vault.apyPct,
      tvlUsd,
      tvlUsdRaw: vault.tvlUsd,
      feePct: Number.isFinite(feePct) ? feePct : 0,
      feePctRaw: vault.feePct
    });
  }

  const maxTvl = eligible.reduce((acc, vault) => (vault.tvlUsd > acc ? vault.tvlUsd : acc), 0);
  const maxApy = eligible.reduce((acc, vault) => (vault.apyPct > acc ? vault.apyPct : acc), 0);
  const rewardsPenaltyThreshold = maxApy > 0 ? maxApy * 0.75 : Infinity;

  const ranked: RankedCandidate[] = eligible.map((candidate) => {
    const normalizedTvl = maxTvl > 0 ? candidate.tvlUsd / maxTvl : 0;
    const apyTerm = preset.scoreWeights.apy * candidate.apyPct;
    const tvlTerm = preset.scoreWeights.tvl * normalizedTvl * 10;
    const feeTerm = -preset.scoreWeights.fee * candidate.feePct;
    const dislikesRewards = preset.rewardPreference === "ignore";
    const rewardsPenaltyTerm =
      dislikesRewards && candidate.apyPct >= rewardsPenaltyThreshold
        ? -preset.scoreWeights.rewardsPenalty * (candidate.apyPct - rewardsPenaltyThreshold)
        : 0;

    const score = apyTerm + tvlTerm + feeTerm + rewardsPenaltyTerm;

    return {
      ...candidate,
      score,
      scoreBreakdown: {
        apyTerm,
        tvlTerm,
        feeTerm,
        rewardsPenaltyTerm
      }
    };
  });

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.apyPct !== left.apyPct) return right.apyPct - left.apyPct;
    return right.tvlUsd - left.tvlUsd;
  });

  return {
    ranked,
    rejected
  };
}

function allocateTargets(total: bigint, candidates: RankedCandidate[], preset: RiskPreset): Map<string, bigint> {
  const targets = new Map<string, bigint>();
  if (total <= 0n || candidates.length === 0) return targets;

  const cap = (total * capBps(preset.maxSingleVaultPct)) / 10_000n;
  const weights = candidates.map((_, index) => BigInt(candidates.length - index));
  const remainingIndices = new Set(candidates.map((_, index) => index));
  let remainingTotal = total;

  while (remainingIndices.size > 0) {
    const active = [...remainingIndices];
    const totalWeight = sum(active.map((index) => weights[index]));
    let capped = false;

    for (const index of active) {
      const proposed = scaleAmount(remainingTotal, weights[index], totalWeight);
      if (proposed > cap) {
        targets.set(candidates[index].address, cap);
        remainingIndices.delete(index);
        remainingTotal -= cap;
        capped = true;
      }
    }

    if (capped) continue;

    let allocated = 0n;
    active.forEach((index, position) => {
      const amount =
        position === active.length - 1
          ? remainingTotal - allocated
          : scaleAmount(remainingTotal, weights[index], totalWeight);
      allocated += amount;
      targets.set(candidates[index].address, amount);
      remainingIndices.delete(index);
    });
  }

  return targets;
}

function plannedTurnover(actions: ActionDraft[]): bigint {
  return sum(actions.map((action) => action.amount));
}

function trimActions(actions: ActionDraft[]): ActionDraft[] {
  return actions.filter((action) => action.amount >= MIN_ACTION_USDC);
}

function capDepositsToAvailableCash(actions: ActionDraft[], currentIdle: bigint, targetIdle: bigint): ActionDraft[] {
  const withdraws = sum(actions.filter((action) => action.kind === "withdraw").map((action) => action.amount));
  const deposits = actions.filter((action) => action.kind === "deposit");
  const available = currentIdle + withdraws > targetIdle ? currentIdle + withdraws - targetIdle : 0n;
  const desiredDeposits = sum(deposits.map((action) => action.amount));

  if (desiredDeposits <= available) return actions;
  if (available <= 0n) return actions.filter((action) => action.kind !== "deposit");

  const scaledDeposits = deposits.map((action) => ({
    ...action,
    amount: scaleAmount(action.amount, available, desiredDeposits),
    clippedByTurnover: false
  }));

  const depositMap = new Map(scaledDeposits.map((action) => [action.vaultAddress, action]));
  return trimActions(
    actions
      .map((action) => (action.kind === "deposit" ? depositMap.get(action.vaultAddress) ?? action : action))
      .filter(Boolean) as ActionDraft[]
  );
}

function driftExceeded(
  totalManaged: bigint,
  targetIdle: bigint,
  currentIdle: bigint,
  currentAmounts: Map<string, bigint>,
  targetAmounts: Map<string, bigint>,
  preset: RiskPreset
): { exceeded: boolean; maxObservedPct: string } {
  if (totalManaged <= 0n) {
    return { exceeded: false, maxObservedPct: "0.00" };
  }

  let maxDrift = bigintAbs(currentIdle - targetIdle);
  for (const [address, currentAmount] of currentAmounts.entries()) {
    const targetAmount = targetAmounts.get(address) ?? 0n;
    const drift = bigintAbs(currentAmount - targetAmount);
    if (drift > maxDrift) maxDrift = drift;
  }

  for (const [address, targetAmount] of targetAmounts.entries()) {
    if (currentAmounts.has(address)) continue;
    if (targetAmount > maxDrift) maxDrift = targetAmount;
  }

  const maxObservedPct = ratioPctString(maxDrift, totalManaged);
  const thresholdAmount = scaleAmount(
    totalManaged,
    BigInt(Math.round(preset.rebalanceDriftPct * 10_000)),
    10_000n
  );

  return {
    exceeded: maxDrift > thresholdAmount,
    maxObservedPct
  };
}

function buildActionDrafts(params: {
  selected: RankedCandidate[];
  currentAmounts: Map<string, bigint>;
  targetAmounts: Map<string, bigint>;
  vaultNames: Map<string, string>;
}): ActionDraft[] {
  const selectedByAddress = new Map(params.selected.map((vault) => [vault.address, vault]));
  const allAddresses = new Set<string>([
    ...params.currentAmounts.keys(),
    ...params.targetAmounts.keys()
  ]);

  const actions: ActionDraft[] = [];

  for (const address of allAddresses) {
    const currentAmount = params.currentAmounts.get(address) ?? 0n;
    const targetAmount = params.targetAmounts.get(address) ?? 0n;
    const diff = targetAmount - currentAmount;
    const vault = selectedByAddress.get(address);
    const vaultName = vault?.name ?? params.vaultNames.get(address) ?? address;

    if (diff > MIN_ACTION_USDC) {
      actions.push({
        kind: "deposit",
        vaultAddress: address,
        vaultName,
        currentAmount,
        targetAmount,
        amount: diff,
        clippedByTurnover: false
      });
    } else if (diff < -MIN_ACTION_USDC) {
      actions.push({
        kind: "withdraw",
        vaultAddress: address,
        vaultName,
        currentAmount,
        targetAmount,
        amount: -diff,
        clippedByTurnover: false
      });
    }
  }

  actions.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "withdraw" ? -1 : 1;
    return right.amount > left.amount ? 1 : right.amount < left.amount ? -1 : 0;
  });

  return actions;
}

async function prepareActionOperations(
  profile: VaultManagerProfile,
  actions: ActionDraft[],
  deps: RebalanceReadDeps
): Promise<RebalanceOperationResult[]> {
  const operations: RebalanceOperationResult[] = [];

  for (const action of actions) {
    const amountUsdc = formatUsdc(action.amount);

    try {
      const prepared =
        action.kind === "deposit"
          ? await deps.prepareDeposit(action.vaultAddress, profile.walletAddress, amountUsdc)
          : await deps.prepareWithdraw(action.vaultAddress, profile.walletAddress, amountUsdc);

      operations.push(toOperationResult(action, prepared));
      if (!operations[operations.length - 1].simulationOk) {
        break;
      }
    } catch (error) {
      operations.push({
        kind: action.kind,
        vaultAddress: action.vaultAddress,
        vaultName: action.vaultName,
        amountUsdc,
        simulationOk: false,
        warnings: [],
        transactions: [],
        error: (error as Error).message
      });
      break;
    }
  }

  return operations;
}

function toOperationResult(action: ActionDraft, prepared: MorphoPreparedOperation): RebalanceOperationResult {
  return {
    kind: action.kind,
    vaultAddress: action.vaultAddress,
    vaultName: action.vaultName,
    amountUsdc: formatUsdc(action.amount),
    summary: prepared.summary,
    simulationOk: Boolean(prepared.simulationOk ?? prepared.simulated),
    warnings: prepared.warnings ?? [],
    transactions: prepared.transactions
  };
}

function toSerializableTransaction(params: {
  tx: MorphoUnsignedTransaction;
  nonce: number;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): TransactionSerializableEIP1559 {
  return {
    type: "eip1559",
    chainId: base.id,
    nonce: params.nonce,
    gas: params.gas,
    maxFeePerGas: params.maxFeePerGas,
    maxPriorityFeePerGas: params.maxPriorityFeePerGas,
    to: getAddress(params.tx.to),
    data: params.tx.data,
    value: BigInt(params.tx.value || "0")
  };
}

function resolveSignedTransaction(unsignedTransactionHex: Hex, payload: {
  signature?: string;
  signedTransaction?: string;
}): Hex {
  if (payload.signedTransaction) {
    return payload.signedTransaction as Hex;
  }

  if (!payload.signature) {
    throw new Error("OWS did not return a usable signature or signed transaction payload.");
  }

  const signature = parseSignature(payload.signature as Hex);
  const parsedUnsigned = parseTransaction(unsignedTransactionHex) as TransactionSerializableEIP1559;
  return serializeTransaction(parsedUnsigned, signature);
}

async function executeOperations(params: {
  settings: VaultManagerSettings;
  profile: VaultManagerProfile;
  operations: RebalanceOperationResult[];
  token: string;
}): Promise<{ rpcUrl?: string; transactions: ExecutedTransactionReceipt[] }> {
  const transport = params.settings.baseRpcUrl ? http(params.settings.baseRpcUrl) : http();
  const publicClient = createPublicClient({
    chain: base,
    transport
  });

  const fees = await publicClient.estimateFeesPerGas({
    chain: base,
    type: "eip1559"
  });

  const maxPriorityFeePerGas =
    fees.maxPriorityFeePerGas ?? fees.gasPrice ?? 1_000_000n;
  const maxFeePerGas =
    fees.maxFeePerGas ?? fees.gasPrice ?? maxPriorityFeePerGas;

  let nonce = await publicClient.getTransactionCount({
    address: getAddress(params.profile.walletAddress),
    blockTag: "pending"
  });

  const receipts: ExecutedTransactionReceipt[] = [];

  for (const operation of params.operations) {
    for (const tx of operation.transactions) {
      const account = getAddress(params.profile.walletAddress);
      const gasEstimate = await publicClient.estimateGas({
        account,
        to: getAddress(tx.to),
        data: tx.data,
        value: BigInt(tx.value || "0"),
        nonce
      });

      const serializable = toSerializableTransaction({
        tx,
        nonce,
        gas: (gasEstimate * 12n) / 10n,
        maxFeePerGas,
        maxPriorityFeePerGas
      });

      const unsignedTransactionHex = serializeTransaction(serializable);
      const signResult = await signTransactionWithOws({
        settings: params.settings,
        walletRef: params.profile.walletRef,
        token: params.token,
        chain: "base",
        unsignedTransactionHex
      });

      if (!signResult.ok) {
        throw new Error(signResult.error ?? "OWS signing failed.");
      }

      const signedTransaction = resolveSignedTransaction(unsignedTransactionHex, signResult.payload);
      const transactionHash =
        signResult.payload.transactionHash ??
        (await publicClient.sendRawTransaction({
          serializedTransaction: signedTransaction
        }));

      const receipt = await publicClient.waitForTransactionReceipt({
        hash: transactionHash as Hex
      });

      if (receipt.status !== "success") {
        throw new Error(`Transaction ${transactionHash} reverted.`);
      }

      receipts.push({
        description: tx.description ?? operation.summary ?? `${operation.kind} ${operation.amountUsdc} USDC`,
        hash: transactionHash,
        status: "success",
        gasUsed: receipt.gasUsed.toString(),
        blockNumber: receipt.blockNumber.toString()
      });

      nonce += 1;
    }
  }

  return {
    rpcUrl: params.settings.baseRpcUrl,
    transactions: receipts
  };
}

function receiptPathForRun(settings: VaultManagerSettings, profileId: string, runId: string): string {
  return path.join(settings.dataRoot, "runs", profileId, `${runId}.json`);
}

function currentAmountsFromPositions(positions: MorphoVaultPosition[]): Map<string, bigint> {
  return new Map(
    positions.map((position) => [position.vault.address, toUsdcUnits(position.supplied.value)])
  );
}

function allocationRows(params: {
  currentAmounts: Map<string, bigint>;
  targetAmounts: Map<string, bigint>;
  vaultNames: Map<string, string>;
  totalManaged: bigint;
}): RebalanceRunResult["allocations"] {
  const addresses = [...new Set([...params.currentAmounts.keys(), ...params.targetAmounts.keys()])];

  return addresses
    .map((address) => {
      const currentUsdc = params.currentAmounts.get(address) ?? 0n;
      const targetUsdc = params.targetAmounts.get(address) ?? 0n;
      const diffUsdc = targetUsdc - currentUsdc;
      return {
        sortTarget: targetUsdc,
        vaultAddress: address,
        vaultName: params.vaultNames.get(address) ?? address,
        currentUsdc: formatUsdc(currentUsdc),
        targetUsdc: formatUsdc(targetUsdc),
        diffUsdc: formatUsdc(diffUsdc),
        currentPct: ratioPctString(currentUsdc, params.totalManaged),
        targetPct: ratioPctString(targetUsdc, params.totalManaged)
      };
    })
    .sort((left, right) => (right.sortTarget > left.sortTarget ? 1 : right.sortTarget < left.sortTarget ? -1 : 0))
    .map(({ sortTarget: _, ...row }) => row);
}

export async function runRebalance(
  settings: VaultManagerSettings,
  profileId: string,
  mode: RebalanceMode,
  overrideDeps?: RebalanceReadDeps
): Promise<RebalanceRunResult> {
  const loaded = await loadProfile(settings, profileId);
  const profile = loaded.profile;
  if (!profile) {
    throw new Error(`Profile ${profileId} does not exist.`);
  }

  const deps = overrideDeps ?? defaultReadDeps(settings, profile);

  const runId = randomUUID();
  const createdAt = new Date().toISOString();
  const receiptPath = receiptPathForRun(settings, profile.profileId, runId);
  const logPath = runLogPathFor(settings, profile.profileId, runId);
  const logger = await createRunLogger({
    settings,
    profileId: profile.profileId,
    runId,
    mode
  });
  const tokenSource = profile.tokenSource ?? settings.defaultTokenSource;
  const tokenSourceDescription = describeTokenSource(tokenSource);
  const tokenReadyProbe = await resolveApiToken(tokenSource);
  const tokenReady = tokenReadyProbe.ok;

  await logger.event("start", "Rebalance run started", {
    mode,
    walletAddress: profile.walletAddress,
    chain: profile.chain,
    riskProfile: profile.riskProfile,
    logPath
  });

  const blockers: string[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];
  const execution: RebalanceRunResult["execution"] = {
    rpcUrl: settings.baseRpcUrl,
    transactions: []
  };

  await logger.event("read", "Fetching live Morpho state");

  const liveVaults = await deps.queryVaults();
  const rejectedVaults: Array<{ address: string; reason: string }> = [];

  const { ranked, rejected } = buildRankedCandidates(liveVaults, profile.riskPreset);
  rejectedVaults.push(...rejected);
  const selected = ranked.slice(0, profile.riskPreset.maxVaults);
  const selectedAddresses = new Set(selected.map((vault) => vault.address));
  rejectedVaults.push(
    ...ranked
      .filter((vault) => !selectedAddresses.has(vault.address))
      .map((vault) => ({
        address: vault.address,
        reason: `Ranked below max vault count ${profile.riskPreset.maxVaults}.`
      }))
  );

  const candidateVaultSet = new Set<string>(liveVaults.map((vault) => getAddress(vault.address)));

  const positionsResponse = await deps.getPositions(profile.walletAddress);
  const tokenBalance = await deps.getTokenBalance(profile.walletAddress);
  const { blockers: positionBlockers, nonUsdcVaultRejections, supportedVaultPositions } =
    collectUnsupportedPositionReasons({
      positionsResponse,
      candidateVaultSet
    });
  blockers.push(...positionBlockers);
  rejectedVaults.push(...nonUsdcVaultRejections);

  const managedPositions = supportedVaultPositions;

  const currentAmounts = currentAmountsFromPositions(managedPositions);
  const idleUsdc = toUsdcUnits(tokenBalance.balance.value);
  const currentManagedInVaults = sum([...currentAmounts.values()]);
  const totalManaged = idleUsdc + currentManagedInVaults;
  const targetIdle = targetCashBuffer(totalManaged, profile.riskPreset);
  const investable = totalManaged > targetIdle ? totalManaged - targetIdle : 0n;
  const targetAmounts = allocateTargets(investable, selected, profile.riskPreset);
  const drift = driftExceeded(
    totalManaged,
    targetIdle,
    idleUsdc,
    currentAmounts,
    targetAmounts,
    profile.riskPreset
  );

  const vaultNames = new Map<string, string>();
  for (const vault of liveVaults) vaultNames.set(vault.address, vault.name);
  for (const position of managedPositions) vaultNames.set(position.vault.address, position.vault.name);

  const topVaultSetChange = topVaultSetChangedMaterially({
    selected,
    positions: managedPositions
  });

  if (topVaultSetChange.changed) {
    warnings.push(
      `Current top vault set changed materially: ${topVaultSetChange.detail}.`
    );
  }

  let actions = buildActionDrafts({
    selected,
    currentAmounts,
    targetAmounts,
    vaultNames
  });

  const turnoverCap = parseUnits(String(profile.riskPreset.maxTurnoverUsd), USDC_DECIMALS);
  const plannedTurnoverUsdc = plannedTurnover(actions);
  if (plannedTurnoverUsdc > turnoverCap) {
    blockers.push(
      `Proposed turnover ${formatUsdc(plannedTurnoverUsdc)} USDC exceeds the configured cap of ${formatUsdc(turnoverCap)} USDC.`
    );
  }
  actions = capDepositsToAvailableCash(actions, idleUsdc, targetIdle);

  if (blockers.length === 0) {
    if (totalManaged === 0n) {
      reasons.push("No USDC balance and no managed Morpho vault positions were found.");
    }
    if (selected.length === 0) {
      reasons.push("No candidate vaults passed the current risk constraints.");
    }
    if (totalManaged > 0n && !drift.exceeded && !topVaultSetChange.changed) {
      reasons.push(
        `Current allocation drift (${drift.maxObservedPct}%) is below the configured threshold (${percentString(
          profile.riskPreset.rebalanceDriftPct * 100
        )}%).`
      );
    }
  }

  if (actions.length === 0 && reasons.length === 0 && blockers.length === 0) {
    reasons.push("The computed action set rounded down to zero after turnover and minimum-size checks.");
  }

  await logger.event("plan", "Computed target allocation", {
    totalManagedUsdc: formatUsdc(totalManaged),
    idleUsdc: formatUsdc(idleUsdc),
    targetCashBufferUsdc: formatUsdc(targetIdle),
    driftExceeded: drift.exceeded,
    maxObservedDriftPct: drift.maxObservedPct,
    topVaultSetChangedMaterially: topVaultSetChange.changed,
    nonUsdcVaultPositionCount: nonUsdcVaultRejections.length,
    marketPositionCount: positionsResponse.marketPositions.length,
    turnoverCapExceeded: plannedTurnoverUsdc > turnoverCap,
    selectedVaults: selected.map((vault) => vault.address),
    actionCount: actions.length
  });

  const actionResults = actions.map<RebalanceAction>((action) => ({
    kind: action.kind,
    vaultAddress: action.vaultAddress,
    vaultName: action.vaultName,
    amountUsdc: formatUsdc(action.amount),
    currentUsdc: formatUsdc(action.currentAmount),
    targetUsdc: formatUsdc(action.targetAmount),
    clippedByTurnover: action.clippedByTurnover
  }));

  let operations: RebalanceOperationResult[] = [];
  let status: RebalanceStatus =
    blockers.length > 0 ? "blocked" : reasons.length > 0 ? "no_op" : "planned";

  if (status === "planned") {
    await logger.event("prepare", "Preparing Morpho transactions", {
      actionCount: actions.length
    });
    operations = await prepareActionOperations(profile, actions, deps);
    const failedOperation = operations.find((operation) => !operation.simulationOk || Boolean(operation.error));
    if (failedOperation) {
      blockers.push(
        failedOperation.error ??
          `Simulation failed for ${failedOperation.kind} ${failedOperation.amountUsdc} USDC on ${failedOperation.vaultAddress}.`
      );
      status = "blocked";
      await logger.event("error", "Preparation or simulation failed", {
        vaultAddress: failedOperation.vaultAddress,
        kind: failedOperation.kind,
        error: failedOperation.error ?? null
      });
    } else {
      await logger.event("prepare", "All prepared operations simulated successfully", {
        operationCount: operations.length
      });
    }
  }

  if (mode === "live" && status === "planned") {
    const source = profile.tokenSource ?? settings.defaultTokenSource;
    const resolution = await resolveApiToken(source);

    if (!resolution.ok) {
      status = "blocked";
      reasons.push(`Failed to resolve OWS API token (${resolution.description}): ${resolution.error}`);
      await logger.event("error", "Live execution blocked: token resolution failed", {
        tokenSource: describeTokenSource(source)
      });
    } else {
      try {
        await logger.event("execute", "Signing and broadcasting transactions", {
          operationCount: operations.length,
          tokenSource: resolution.description
        });
        const liveExecution = await executeOperations({
          settings,
          profile,
          operations,
          token: resolution.value
        });
        execution.rpcUrl = liveExecution.rpcUrl;
        execution.transactions = liveExecution.transactions;
        status = "executed";
        await logger.event("verify", "Transactions confirmed", {
          transactionCount: liveExecution.transactions.length,
          hashes: liveExecution.transactions.map((tx) => tx.hash)
        });
      } catch (error) {
        status = "blocked";
        reasons.push((error as Error).message);
        await logger.event("error", "Live execution failed", {
          error: (error as Error).message
        });
      }
    }
  }

  const result: RebalanceRunResult = {
    runId,
    mode,
    status: blockers.length > 0 ? "blocked" : status,
    profileId: profile.profileId,
    createdAt,
    receiptPath,
    logPath,
    walletAddress: profile.walletAddress,
    riskProfile: profile.riskProfile,
    tokenEnvVar: profile.tokenEnvVar,
    tokenSource: tokenSourceDescription,
    tokenReady,
    reasons: [...blockers, ...reasons],
    warnings: [
      ...warnings,
      ...operations.flatMap((operation) =>
        operation.warnings.map((warning) => `${warning.level}: ${warning.message}`)
      )
    ],
    metrics: {
      idleUsdc: formatUsdc(idleUsdc),
      totalManagedUsdc: formatUsdc(totalManaged),
      targetCashBufferUsdc: formatUsdc(targetIdle),
      driftThresholdPct: percentString(profile.riskPreset.rebalanceDriftPct * 100),
      maxObservedDriftPct: drift.maxObservedPct,
      turnoverCapUsdc: formatUsdc(turnoverCap),
      totalPlannedTurnoverUsdc: formatUsdc(plannedTurnover(actions))
    },
    vaults: {
      selected: selected.map((vault) => ({
        address: vault.address,
        name: vault.name,
        apyPct: vault.apyPctRaw,
        feePct: vault.feePctRaw,
        tvlUsd: vault.tvlUsdRaw,
        score: vault.score.toFixed(4),
        scoreBreakdown: {
          apyTerm: vault.scoreBreakdown.apyTerm.toFixed(4),
          tvlTerm: vault.scoreBreakdown.tvlTerm.toFixed(4),
          feeTerm: vault.scoreBreakdown.feeTerm.toFixed(4),
          rewardsPenaltyTerm: vault.scoreBreakdown.rewardsPenaltyTerm.toFixed(4)
        }
      })),
      rejected: rejectedVaults
    },
    allocations: allocationRows({
      currentAmounts,
      targetAmounts,
      vaultNames,
      totalManaged
    }),
    actions: actionResults,
    operations,
    execution
  };

  await persistRunReceipt(result);
  await logger.event("complete", "Rebalance run complete", {
    status,
    actionCount: result.actions.length,
    executedTransactionCount: result.execution.transactions.length,
    receiptPath: result.receiptPath
  });
  await logger.close();
  return result;
}

async function persistRunReceipt(result: RebalanceRunResult): Promise<void> {
  await ensureDir(path.dirname(result.receiptPath));
  await writeJsonFile(result.receiptPath, result);
}
