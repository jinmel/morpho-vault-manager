import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";
import { formatUnits, parseUnits } from "viem";
import { readJsonFile } from "../lib/fs.js";
import type { PlanResult, PlanStatus } from "../lib/rebalance.js";
import { runLogPathFor } from "../lib/run-logger.js";
import type { VaultManagerSettings } from "../lib/types.js";

const USDC_DECIMALS = 6;
const MIN_PREFIX_LENGTH = 6;
const DEFAULT_LIMIT = 20;

export type PerRunEnrichment = {
  plannedTurnoverPctOfManaged: string;
  actionCountByKind: { deposit: number; withdraw: number };
  allocationDeltas: Array<{
    vaultAddress: string;
    priorTargetPct: string | null;
    currentTargetPct: string;
    deltaPct: string | null;
  }>;
};

export type HistoryAggregateMetrics = {
  runCount: number;
  plannedCount: number;
  noOpCount: number;
  blockedCount: number;
  avgMaxDriftPct: string;
  avgTurnoverUsdc: string;
  medianIntervalMinutes: number | null;
  uniqueVaultsTouched: number;
  vaultChurnCount: number;
};

export type HistoryOptions = {
  profileId: string;
  json: boolean;
  run?: string;
  logs?: string;
  since?: string;
  status?: PlanStatus;
  limit?: number;
};

type PrefixResolution =
  | { kind: "ok"; runId: string }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "prefix_too_short" };

class ReceiptShapeError extends Error {
  constructor(runId: string, filePath: string, missing: string[]) {
    super(`Receipt ${runId} at ${filePath} is missing required keys: ${missing.join(", ")}.`);
    this.name = "ReceiptShapeError";
  }
}

const REQUIRED_RECEIPT_KEYS: Array<keyof PlanResult> = [
  "runId",
  "status",
  "createdAt",
  "metrics",
  "allocations",
  "actions"
];

function receiptsDirFor(settings: VaultManagerSettings, profileId: string): string {
  return path.join(settings.dataRoot, "runs", profileId);
}

function receiptPathFor(
  settings: VaultManagerSettings,
  profileId: string,
  runId: string
): string {
  return path.join(receiptsDirFor(settings, profileId), `${runId}.json`);
}

async function listRunIds(
  settings: VaultManagerSettings,
  profileId: string
): Promise<string[]> {
  const dir = receiptsDirFor(settings, profileId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const jsonFiles = entries.filter((name) => name.endsWith(".json"));
  const withStat = await Promise.all(
    jsonFiles.map(async (name) => {
      const stat = await fs.stat(path.join(dir, name));
      return { runId: name.slice(0, -".json".length), mtimeMs: stat.mtimeMs };
    })
  );
  withStat.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return withStat.map((item) => item.runId);
}

async function loadReceipt(
  settings: VaultManagerSettings,
  profileId: string,
  runId: string
): Promise<PlanResult> {
  const filePath = receiptPathFor(settings, profileId, runId);
  const data = await readJsonFile<Record<string, unknown>>(filePath);
  if (!data) {
    throw new ReceiptShapeError(runId, filePath, ["<file not found>"]);
  }
  const missing = REQUIRED_RECEIPT_KEYS.filter((key) => !(key in data));
  if (missing.length > 0) {
    throw new ReceiptShapeError(runId, filePath, missing);
  }
  return data as unknown as PlanResult;
}

function resolveRunPrefix(runIds: string[], prefix: string): PrefixResolution {
  const exact = runIds.find((id) => id === prefix);
  if (exact) return { kind: "ok", runId: exact };
  if (prefix.length < MIN_PREFIX_LENGTH) return { kind: "prefix_too_short" };
  const matches = runIds.filter((id) => id.startsWith(prefix));
  if (matches.length === 0) return { kind: "not_found" };
  if (matches.length === 1) return { kind: "ok", runId: matches[0] };
  return { kind: "ambiguous", candidates: matches };
}

async function streamLog(
  settings: VaultManagerSettings,
  profileId: string,
  runId: string,
  writable: Writable
): Promise<void> {
  const logPath = runLogPathFor(settings, profileId, runId);
  try {
    await fs.stat(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`No log file for run ${runId} at ${logPath}.`);
    }
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(logPath);
    stream.on("error", reject);
    stream.on("end", resolve);
    stream.pipe(writable, { end: false });
  });
}

function toUsdcUnits(value: string): bigint {
  return parseUnits(value, USDC_DECIMALS);
}

function formatUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}

function ratioPctString(numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) return "0.00";
  return ((Number(numerator) / Number(denominator)) * 100).toFixed(2);
}

function parsePct(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function subPctString(current: string, prior: string): string {
  return (parsePct(current) - parsePct(prior)).toFixed(2);
}

export function computePerRunEnrichment(
  current: PlanResult,
  prior: PlanResult | null
): PerRunEnrichment {
  const managed = toUsdcUnits(current.metrics.totalManagedUsdc);
  const turnover = toUsdcUnits(current.metrics.totalPlannedTurnoverUsdc);
  const plannedTurnoverPctOfManaged = ratioPctString(turnover, managed);

  let deposit = 0;
  let withdraw = 0;
  for (const action of current.actions) {
    if (action.kind === "deposit") deposit += 1;
    else if (action.kind === "withdraw") withdraw += 1;
  }

  const priorByAddress = new Map<string, string>();
  if (prior) {
    for (const allocation of prior.allocations) {
      priorByAddress.set(allocation.vaultAddress, allocation.targetPct);
    }
  }

  const allocationDeltas = current.allocations.map((allocation) => {
    const priorTargetPct = priorByAddress.get(allocation.vaultAddress) ?? null;
    const currentTargetPct = allocation.targetPct;
    const deltaPct =
      priorTargetPct === null ? null : subPctString(currentTargetPct, priorTargetPct);
    return {
      vaultAddress: allocation.vaultAddress,
      priorTargetPct,
      currentTargetPct,
      deltaPct
    };
  });

  return {
    plannedTurnoverPctOfManaged,
    actionCountByKind: { deposit, withdraw },
    allocationDeltas
  };
}

function averageBigInt(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sum = values.reduce((acc, value) => acc + value, 0n);
  return sum / BigInt(values.length);
}

function medianNumber(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function compareCreatedAt(a: PlanResult, b: PlanResult): number {
  if (a.createdAt < b.createdAt) return -1;
  if (a.createdAt > b.createdAt) return 1;
  return 0;
}

export function computeAggregateMetrics(runs: PlanResult[]): HistoryAggregateMetrics {
  const runCount = runs.length;
  const plannedCount = runs.filter((run) => run.status === "planned").length;
  const noOpCount = runs.filter((run) => run.status === "no_op").length;
  const blockedCount = runs.filter((run) => run.status === "blocked").length;

  let avgMaxDriftPct = "0.00";
  let avgTurnoverUsdc = "0";
  if (runCount > 0) {
    const driftMean =
      runs.reduce((acc, run) => acc + parsePct(run.metrics.maxDriftPct), 0) / runCount;
    avgMaxDriftPct = driftMean.toFixed(2);
    const turnoverMean = averageBigInt(
      runs.map((run) => toUsdcUnits(run.metrics.totalPlannedTurnoverUsdc))
    );
    avgTurnoverUsdc = formatUsdc(turnoverMean);
  }

  const chronological = [...runs].sort(compareCreatedAt);

  let medianIntervalMinutes: number | null = null;
  if (chronological.length >= 2) {
    const intervals: number[] = [];
    for (let i = 1; i < chronological.length; i += 1) {
      const prev = new Date(chronological[i - 1].createdAt).getTime();
      const next = new Date(chronological[i].createdAt).getTime();
      intervals.push((next - prev) / 60_000);
    }
    medianIntervalMinutes = medianNumber(intervals);
  }

  const uniqueVaults = new Set<string>();
  for (const run of runs) {
    for (const vault of run.vaults.selected) {
      uniqueVaults.add(vault.address);
    }
  }
  const uniqueVaultsTouched = uniqueVaults.size;

  let vaultChurnCount = 0;
  if (uniqueVaultsTouched > 1 && chronological.length >= 2) {
    for (let i = 1; i < chronological.length; i += 1) {
      const prevTop = chronological[i - 1].vaults.selected[0]?.address;
      const currTop = chronological[i].vaults.selected[0]?.address;
      if (prevTop && currTop && prevTop !== currTop) vaultChurnCount += 1;
    }
  }

  return {
    runCount,
    plannedCount,
    noOpCount,
    blockedCount,
    avgMaxDriftPct,
    avgTurnoverUsdc,
    medianIntervalMinutes,
    uniqueVaultsTouched,
    vaultChurnCount
  };
}

function renderTable(rows: string[][], columns: string[]): string {
  const all = [columns, ...rows];
  const widths = columns.map((_, colIdx) =>
    all.reduce((max, row) => Math.max(max, (row[colIdx] ?? "").length), 0)
  );
  const formatRow = (row: string[]): string =>
    row.map((cell, idx) => (cell ?? "").padEnd(widths[idx])).join("  ").trimEnd();
  const separator = widths.map((width) => "-".repeat(width));
  return [formatRow(columns), formatRow(separator), ...rows.map(formatRow)].join("\n");
}

function applyFilters(
  runs: PlanResult[],
  opts: { since?: string; status?: PlanStatus; limit: number }
): PlanResult[] {
  let filtered = runs;
  if (opts.since) {
    const sinceMs = new Date(opts.since).getTime();
    if (Number.isNaN(sinceMs)) {
      throw new Error(`--since must be a valid ISO date (got '${opts.since}').`);
    }
    filtered = filtered.filter((run) => new Date(run.createdAt).getTime() >= sinceMs);
  }
  if (opts.status) {
    filtered = filtered.filter((run) => run.status === opts.status);
  }
  if (opts.limit > 0) {
    filtered = filtered.slice(0, opts.limit);
  }
  return filtered;
}

function shortId(runId: string): string {
  return runId.slice(0, 8);
}

async function loadAllReceipts(
  settings: VaultManagerSettings,
  profileId: string,
  runIds: string[]
): Promise<PlanResult[]> {
  const receipts: PlanResult[] = [];
  for (const runId of runIds) {
    try {
      receipts.push(await loadReceipt(settings, profileId, runId));
    } catch (error) {
      process.stderr.write(
        `warning: skipping unreadable receipt ${runId}: ${(error as Error).message}\n`
      );
    }
  }
  return receipts;
}

function findPriorRun(current: PlanResult, all: PlanResult[]): PlanResult | null {
  const currentMs = new Date(current.createdAt).getTime();
  let best: PlanResult | null = null;
  let bestMs = -Infinity;
  for (const candidate of all) {
    if (candidate.runId === current.runId) continue;
    const ms = new Date(candidate.createdAt).getTime();
    if (ms < currentMs && ms > bestMs) {
      bestMs = ms;
      best = candidate;
    }
  }
  return best;
}

function formatResolutionError(resolution: PrefixResolution, input: string): string {
  switch (resolution.kind) {
    case "prefix_too_short":
      return `Run prefix '${input}' is too short; provide at least ${MIN_PREFIX_LENGTH} characters or the full runId.`;
    case "not_found":
      return `No run matched '${input}'.`;
    case "ambiguous":
      return `Run prefix '${input}' is ambiguous. Candidates:\n  - ${resolution.candidates.join("\n  - ")}`;
    case "ok":
      return "";
  }
}

function renderListView(
  profileId: string,
  runs: PlanResult[],
  metrics: HistoryAggregateMetrics
): string {
  const columns = [
    "runId",
    "createdAt",
    "status",
    "maxDriftPct",
    "actions",
    "turnoverUsdc",
    "vaults"
  ];
  const rows = runs.map((run) => [
    shortId(run.runId),
    run.createdAt,
    run.status,
    run.metrics.maxDriftPct,
    String(run.actions.length),
    run.metrics.totalPlannedTurnoverUsdc,
    String(run.vaults.selected.length)
  ]);

  const table = rows.length > 0 ? renderTable(rows, columns) : "(no runs match filter)";
  const summary = [
    `Profile: ${profileId}`,
    `Runs: ${metrics.runCount} (planned=${metrics.plannedCount}, no_op=${metrics.noOpCount}, blocked=${metrics.blockedCount})`,
    `Avg max drift: ${metrics.avgMaxDriftPct}%`,
    `Avg turnover: ${metrics.avgTurnoverUsdc} USDC`,
    `Median interval: ${
      metrics.medianIntervalMinutes === null
        ? "n/a"
        : `${metrics.medianIntervalMinutes.toFixed(1)} min`
    }`,
    `Unique vaults touched: ${metrics.uniqueVaultsTouched}`,
    `Top-vault churn: ${metrics.vaultChurnCount}`
  ].join("\n");
  return [table, "", summary].join("\n");
}

function renderSingleRun(run: PlanResult, enrichment: PerRunEnrichment): string {
  const header = [
    `Run: ${run.runId}`,
    `Created: ${run.createdAt}`,
    `Status: ${run.status}`,
    `Wallet: ${run.walletAddress}`,
    `Managed USDC: ${run.metrics.totalManagedUsdc}`,
    `Idle USDC: ${run.metrics.idleUsdc}`,
    `Max drift: ${run.metrics.maxDriftPct}% (threshold ${run.metrics.driftThresholdPct}%)`,
    `Planned turnover: ${run.metrics.totalPlannedTurnoverUsdc} USDC (${enrichment.plannedTurnoverPctOfManaged}% of managed)`,
    `Actions: ${run.actions.length} (deposit=${enrichment.actionCountByKind.deposit}, withdraw=${enrichment.actionCountByKind.withdraw})`,
    `Receipt: ${run.receiptPath}`,
    `Log: ${run.logPath}`
  ].join("\n");

  const deltaRows = enrichment.allocationDeltas.map((delta) => [
    delta.vaultAddress,
    delta.priorTargetPct ?? "-",
    delta.currentTargetPct,
    delta.deltaPct ?? "-"
  ]);
  const deltaTable =
    deltaRows.length > 0
      ? renderTable(deltaRows, ["vault", "priorPct", "currentPct", "deltaPct"])
      : "(no allocations)";

  const reasons =
    run.reasons.length > 0
      ? "Reasons:\n" + run.reasons.map((reason) => `  - ${reason}`).join("\n")
      : "";
  const warnings =
    run.warnings.length > 0
      ? "Warnings:\n" + run.warnings.map((warning) => `  - ${warning}`).join("\n")
      : "";

  return [header, "", "Allocation deltas:", deltaTable, reasons, warnings]
    .filter((section) => section.length > 0)
    .join("\n");
}

export async function runHistory(
  settings: VaultManagerSettings,
  opts: HistoryOptions
): Promise<void> {
  const { profileId, json } = opts;
  const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;

  if (opts.logs) {
    const runIds = await listRunIds(settings, profileId);
    const resolution = resolveRunPrefix(runIds, opts.logs);
    if (resolution.kind !== "ok") {
      process.stderr.write(`${formatResolutionError(resolution, opts.logs)}\n`);
      process.exitCode = 1;
      return;
    }
    try {
      await streamLog(settings, profileId, resolution.runId, process.stdout);
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (opts.run) {
    const runIds = await listRunIds(settings, profileId);
    const resolution = resolveRunPrefix(runIds, opts.run);
    if (resolution.kind !== "ok") {
      process.stderr.write(`${formatResolutionError(resolution, opts.run)}\n`);
      process.exitCode = 1;
      return;
    }
    const current = await loadReceipt(settings, profileId, resolution.runId);
    const otherReceipts = await loadAllReceipts(
      settings,
      profileId,
      runIds.filter((id) => id !== resolution.runId)
    );
    const prior = findPriorRun(current, otherReceipts);
    const enrichment = computePerRunEnrichment(current, prior);

    if (json) {
      process.stdout.write(
        `${JSON.stringify({ profileId, run: current, enrichment }, null, 2)}\n`
      );
      return;
    }
    process.stdout.write(`${renderSingleRun(current, enrichment)}\n`);
    return;
  }

  const runIds = await listRunIds(settings, profileId);
  if (runIds.length === 0) {
    if (json) {
      const metrics = computeAggregateMetrics([]);
      process.stdout.write(
        `${JSON.stringify({ profileId, runs: [], metrics }, null, 2)}\n`
      );
      return;
    }
    process.stdout.write(`no history for profile ${profileId}\n`);
    return;
  }

  const allReceipts = await loadAllReceipts(settings, profileId, runIds);
  allReceipts.sort((left, right) => -compareCreatedAt(left, right));

  const filtered = applyFilters(allReceipts, {
    since: opts.since,
    status: opts.status,
    limit
  });

  const metrics = computeAggregateMetrics(filtered);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ profileId, runs: filtered, metrics }, null, 2)}\n`
    );
    return;
  }

  process.stdout.write(`${renderListView(profileId, filtered, metrics)}\n`);
}
