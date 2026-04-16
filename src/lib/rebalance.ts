import { randomUUID } from "node:crypto";
import path from "node:path";
import { formatUnits, getAddress, parseUnits } from "viem";
import { USDC_DECIMALS } from "./constants.js";
import { ensureDir, writeJsonFile } from "./fs.js";
import {
  getMorphoPositions,
  getMorphoTokenBalance,
  queryMorphoVaults,
  type MorphoPositionsResponse,
  type MorphoTokenBalanceResponse,
  type MorphoVaultDetail,
  type MorphoVaultPosition
} from "./morpho.js";
import { loadProfile } from "./profile.js";
import { createRunLogger, runLogPathFor } from "./run-logger.js";
import type { RiskPreset, VaultManagerProfile, VaultManagerSettings } from "./types.js";

export type PlanStatus = "no_op" | "planned" | "blocked";

export type PlanReadDeps = {
  queryVaults: () => Promise<MorphoVaultDetail[]>;
  getPositions: (walletAddress: string) => Promise<MorphoPositionsResponse>;
  getTokenBalance: (walletAddress: string) => Promise<MorphoTokenBalanceResponse>;
};

function defaultReadDeps(settings: VaultManagerSettings, profile: VaultManagerProfile): PlanReadDeps {
  return {
    queryVaults: () => queryMorphoVaults(settings, profile.chain, "USDC"),
    getPositions: (walletAddress) => getMorphoPositions(settings, profile.chain, walletAddress),
    getTokenBalance: (walletAddress) =>
      getMorphoTokenBalance(settings, profile.chain, profile.usdcAddress, walletAddress)
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

export type PlanResult = {
  runId: string;
  status: PlanStatus;
  profileId: string;
  createdAt: string;
  receiptPath: string;
  logPath: string;
  walletAddress: string;
  riskProfile: VaultManagerProfile["riskProfile"];
  reasons: string[];
  warnings: string[];
  metrics: {
    idleUsdc: string;
    totalManagedUsdc: string;
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


function sum(values: bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
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
    return supplied > 0n && !selectedAddresses.has(address);
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
  return actions.filter((action) => action.amount > 0n);
}

function capDepositsToAvailableCash(actions: ActionDraft[], currentIdle: bigint): ActionDraft[] {
  const withdraws = sum(actions.filter((action) => action.kind === "withdraw").map((action) => action.amount));
  const deposits = actions.filter((action) => action.kind === "deposit");
  const available = currentIdle + withdraws;
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

    if (diff > 0n) {
      actions.push({
        kind: "deposit",
        vaultAddress: address,
        vaultName,
        currentAmount,
        targetAmount,
        amount: diff,
        clippedByTurnover: false
      });
    } else if (diff < 0n) {
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
}): PlanResult["allocations"] {
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

export async function runPlan(
  settings: VaultManagerSettings,
  profileId: string,
  overrideDeps?: PlanReadDeps
): Promise<PlanResult> {
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
    mode: "plan"
  });

  await logger.event("start", "Plan computation started", {
    walletAddress: profile.walletAddress,
    chain: profile.chain,
    riskProfile: profile.riskProfile,
    logPath
  });

  const blockers: string[] = [];
  const reasons: string[] = [];
  const warnings: string[] = [];

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
  const targetAmounts = allocateTargets(totalManaged, selected, profile.riskPreset);

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
  actions = capDepositsToAvailableCash(actions, idleUsdc);

  if (blockers.length === 0) {
    if (totalManaged === 0n) {
      reasons.push("No USDC balance and no managed Morpho vault positions were found.");
    }
    if (selected.length === 0) {
      reasons.push("No candidate vaults passed the current risk constraints.");
    }
  }

  if (actions.length === 0 && reasons.length === 0 && blockers.length === 0) {
    reasons.push("The computed action set rounded down to zero after turnover and minimum-size checks.");
  }

  await logger.event("plan", "Computed target allocation", {
    totalManagedUsdc: formatUsdc(totalManaged),
    idleUsdc: formatUsdc(idleUsdc),
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

  const status: PlanStatus =
    blockers.length > 0 ? "blocked" : reasons.length > 0 ? "no_op" : "planned";

  const result: PlanResult = {
    runId,
    status,
    profileId: profile.profileId,
    createdAt,
    receiptPath,
    logPath,
    walletAddress: profile.walletAddress,
    riskProfile: profile.riskProfile,
    reasons: [...blockers, ...reasons],
    warnings,
    metrics: {
      idleUsdc: formatUsdc(idleUsdc),
      totalManagedUsdc: formatUsdc(totalManaged),
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
    actions: actionResults
  };

  await persistRunReceipt(result);
  await logger.event("complete", "Plan computation complete", {
    status,
    actionCount: result.actions.length,
    receiptPath: result.receiptPath
  });
  await logger.close();
  return result;
}

async function persistRunReceipt(result: PlanResult): Promise<void> {
  await ensureDir(path.dirname(result.receiptPath));
  await writeJsonFile(result.receiptPath, result);
}
