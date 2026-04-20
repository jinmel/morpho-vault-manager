import * as p from "@clack/prompts";
import { table, type TableUserConfig } from "table";
import { getAddress } from "viem";
import { fetchUserPositions, type MorphoGraphqlUserPositions, type MorphoGraphqlVaultPosition } from "../lib/morpho-graphql.js";
import { loadProfile } from "../lib/profile.js";
import type { VaultManagerSettings } from "../lib/types.js";

type ShowOptions = {
  profile: string;
  json: boolean;
  address?: string;
  chainId?: number;
  endpoint?: string;
  noColor?: boolean;
};

const BAR_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"];

const ANSI = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  gray: "\u001b[90m",
  red: "\u001b[31m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  cyan: "\u001b[36m"
};

function useColor(noColor: boolean): boolean {
  if (noColor) return false;
  if (process.env.NO_COLOR) return false;
  return Boolean(process.stdout.isTTY);
}

type Paint = (s: string) => string;

function makePaint(enabled: boolean): Record<keyof typeof ANSI, Paint> {
  const entries = (Object.keys(ANSI) as Array<keyof typeof ANSI>).map((key) => {
    const code = ANSI[key];
    const fn: Paint = enabled ? (s) => `${code}${s}${ANSI.reset}` : (s) => s;
    return [key, fn] as const;
  });
  return Object.fromEntries(entries) as Record<keyof typeof ANSI, Paint>;
}

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

function padStartVisible(s: string, width: number): string {
  const diff = width - visibleWidth(s);
  return diff <= 0 ? s : " ".repeat(diff) + s;
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0.00";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

function formatPct(fraction: number, digits = 2): string {
  if (!Number.isFinite(fraction)) return "0%";
  return `${(fraction * 100).toFixed(digits)}%`;
}

function formatLltv(lltvWad: string): string {
  if (!lltvWad) return "—";
  try {
    const big = BigInt(lltvWad);
    const scaled = Number(big) / 1e18;
    return `${(scaled * 100).toFixed(1)}%`;
  } catch {
    return "—";
  }
}

function shortHex(address: string, head = 6, tail = 4): string {
  if (!address.startsWith("0x") || address.length <= head + tail + 2) return address;
  return `${address.slice(0, head)}…${address.slice(-tail)}`;
}

function renderBar(fraction: number, width: number): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const totalEighths = Math.round(clamped * width * 8);
  const full = Math.floor(totalEighths / 8);
  const remainder = totalEighths % 8;
  let bar = "█".repeat(full);
  if (remainder > 0 && full < width) bar += BAR_BLOCKS[remainder];
  if (visibleWidth(bar) < width) bar += " ".repeat(width - visibleWidth(bar));
  return bar;
}

type ColumnAlign = "left" | "right";
type Column = { header: string; align?: ColumnAlign };

const BORDERLESS: TableUserConfig["border"] = {
  topBody: "",
  topJoin: "",
  topLeft: "",
  topRight: "",
  bottomBody: "",
  bottomJoin: "",
  bottomLeft: "",
  bottomRight: "",
  bodyLeft: "",
  bodyRight: "",
  bodyJoin: "  ",
  joinBody: "─",
  joinLeft: "",
  joinRight: "",
  joinJoin: "──"
};

function renderTable(columns: Column[], rows: string[][]): string {
  const data: string[][] = [columns.map((c) => c.header), ...rows];
  const config: TableUserConfig = {
    border: BORDERLESS,
    columnDefault: { paddingLeft: 0, paddingRight: 2 },
    columns: columns.map((c, idx) => ({
      alignment: c.align ?? "left",
      paddingRight: idx === columns.length - 1 ? 0 : 2
    })),
    drawHorizontalLine: (lineIndex: number) => lineIndex === 1,
    drawVerticalLine: () => false
  };
  return table(data, config).trimEnd();
}

function renderHeader(data: MorphoGraphqlUserPositions, paint: Record<keyof typeof ANSI, Paint>): string {
  const lines: string[] = [];
  lines.push(`${paint.bold("Owner")}     ${data.userAddress}`);
  lines.push(`${paint.bold("Chain ID")}  ${data.chainId}`);
  lines.push(`${paint.bold("Vaults")}    ${data.vaultPositions.length}`);
  lines.push(`${paint.bold("Total supplied")}  ${paint.green(formatUsd(data.totalSuppliedUsd))}`);
  return lines.join("\n");
}

function renderVaultTable(
  data: MorphoGraphqlUserPositions,
  paint: Record<keyof typeof ANSI, Paint>
): string {
  if (data.vaultPositions.length === 0) return paint.dim("No vault positions.");

  const sorted = [...data.vaultPositions].sort((a, b) => b.assetsUsd - a.assetsUsd);
  const total = data.totalSuppliedUsd || 1;
  const BAR_WIDTH = 16;

  const rows = sorted.map((pos) => {
    const share = pos.assetsUsd / total;
    const bar = renderBar(share, BAR_WIDTH);
    const name = pos.vault.name || pos.vault.symbol || shortHex(pos.vault.address);
    const netApy = pos.vault.state ? formatPct(pos.vault.state.netApy) : "—";
    return [
      paint.cyan(name),
      pos.vault.asset.symbol,
      paint.green(formatUsd(pos.assetsUsd)),
      padStartVisible(formatPct(share, 1), 6),
      paint.blue(bar),
      paint.yellow(netApy),
      paint.gray(shortHex(pos.vault.address))
    ];
  });

  const table = renderTable(
    [
      { header: "Vault" },
      { header: "Asset" },
      { header: "Supplied", align: "right" },
      { header: "Share", align: "right" },
      { header: "Exposure" },
      { header: "Net APY", align: "right" },
      { header: "Address" }
    ],
    rows
  );

  return `${paint.bold("Vault exposure")}\n${table}`;
}

function renderMarketBreakdown(
  pos: MorphoGraphqlVaultPosition,
  paint: Record<keyof typeof ANSI, Paint>
): string {
  const state = pos.vault.state;
  if (!state || state.allocation.length === 0) {
    const vaultLabel = pos.vault.name || pos.vault.symbol || shortHex(pos.vault.address);
    return `${paint.bold(vaultLabel)}  ${paint.dim("(no market allocations reported)")}`;
  }

  const vaultLabel = pos.vault.name || pos.vault.symbol || shortHex(pos.vault.address);
  const vaultTotal = state.totalAssetsUsd || state.allocation.reduce((acc, a) => acc + a.supplyAssetsUsd, 0) || 1;
  const BAR_WIDTH = 14;

  const sorted = [...state.allocation].sort((a, b) => b.supplyAssetsUsd - a.supplyAssetsUsd);

  const rows = sorted.map((alloc) => {
    const share = alloc.supplyAssetsUsd / vaultTotal;
    const bar = renderBar(share, BAR_WIDTH);
    const userShareUsd = share * pos.assetsUsd;
    const collateral = alloc.market.collateralAsset?.symbol ?? "idle";
    const loan = alloc.market.loanAsset.symbol;
    const marketLabel = alloc.market.collateralAsset
      ? `${collateral} / ${loan}`
      : paint.dim("idle liquidity");
    return [
      marketLabel,
      formatLltv(alloc.market.lltv),
      paint.green(formatUsd(alloc.supplyAssetsUsd)),
      padStartVisible(formatPct(share, 1), 6),
      paint.magenta(bar),
      paint.green(formatUsd(userShareUsd)),
      paint.gray(shortHex(alloc.market.uniqueKey, 8, 4))
    ];
  });

  const table = renderTable(
    [
      { header: "Market" },
      { header: "LLTV", align: "right" },
      { header: "Vault→Mkt", align: "right" },
      { header: "Share", align: "right" },
      { header: "Allocation" },
      { header: "Your share", align: "right" },
      { header: "Market key" }
    ],
    rows
  );

  const header = `${paint.bold(vaultLabel)}  ${paint.dim(`(${formatUsd(pos.assetsUsd)} of your funds · vault TVL ${formatUsd(state.totalAssetsUsd)} · net APY ${formatPct(state.netApy)})`)}`;
  return `${header}\n${table}`;
}

export async function runShow(
  settings: VaultManagerSettings,
  opts: ShowOptions
): Promise<void> {
  let address: string;
  if (opts.address) {
    address = getAddress(opts.address);
  } else {
    const { profile } = await loadProfile(settings, opts.profile);
    if (!profile || !profile.walletAddress) {
      const detail = profile
        ? `Profile ${opts.profile} is missing walletAddress.`
        : `Profile ${opts.profile} does not exist. Run 'vault-manager configure' first.`;
      process.stderr.write(`${detail}\n`);
      process.exit(1);
      return;
    }
    address = getAddress(profile.walletAddress);
  }

  const spinner = opts.json ? null : p.spinner();
  spinner?.start(`Fetching positions for ${address} from Morpho GraphQL…`);

  let data: MorphoGraphqlUserPositions;
  try {
    data = await fetchUserPositions(address, {
      chainId: opts.chainId,
      endpoint: opts.endpoint
    });
  } catch (error) {
    spinner?.stop("Failed to fetch Morpho positions", 1);
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exit(1);
    return;
  }

  spinner?.stop(`Fetched ${data.vaultPositions.length} vault position(s).`);

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const paint = makePaint(useColor(Boolean(opts.noColor)));

  const sections: string[] = [];
  sections.push(renderHeader(data, paint));
  sections.push("");
  sections.push(renderVaultTable(data, paint));

  if (data.vaultPositions.length > 0) {
    sections.push("");
    sections.push(paint.bold("Market exposure per vault"));
    const sorted = [...data.vaultPositions].sort((a, b) => b.assetsUsd - a.assetsUsd);
    for (const pos of sorted) {
      sections.push("");
      sections.push(renderMarketBreakdown(pos, paint));
    }
  }

  process.stdout.write(`${sections.join("\n")}\n`);
}
