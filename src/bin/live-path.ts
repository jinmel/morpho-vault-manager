import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getAddress } from "viem";
import { BASE_USDC_ADDRESS, RISK_PRESETS } from "../lib/constants.js";
import {
  getMorphoPositions,
  getMorphoTokenBalance,
  getMorphoVault,
  runMorphoHealthCheck
} from "../lib/morpho.js";
import { openclawGatewayIsReachable } from "../lib/openclaw.js";
import { runPreflightChecks } from "../lib/preflight.js";
import { saveProfile } from "../lib/profile.js";
import { runRebalance } from "../lib/rebalance.js";
import { resolveVaultManagerSettings } from "../lib/settings.js";
import { runCommand } from "../lib/shell.js";
import type { VaultManagerProfile, VaultManagerSettings } from "../lib/types.js";

const execFileAsync = promisify(execFile);

const LIVE_VALIDATION_WALLET = getAddress("0x1111111111111111111111111111111111111111");

type StepResult = {
  id: string;
  description: string;
  status: "pass" | "fail";
  detail?: string;
};

type Args = {
  keep: boolean;
  format: "text" | "json";
};

function parseArgs(argv: string[]): Args {
  const args: Args = { keep: false, format: "text" };
  for (const arg of argv) {
    if (arg === "--keep") args.keep = true;
    else if (arg === "--format=json") args.format = "json";
    else if (arg === "--format=text") args.format = "text";
  }
  return args;
}

type MorphoVaultSummary = {
  address: string;
  name: string;
  asset: { symbol: string };
  apyPct?: string;
  tvlUsd?: string;
  feePct?: string;
};

async function queryBaseUsdcVaults(baseSettings: VaultManagerSettings): Promise<MorphoVaultSummary[]> {
  const result = await runCommand(baseSettings.morphoCliCommand, [
    ...baseSettings.morphoCliArgsPrefix,
    "query-vaults",
    "--chain",
    "base"
  ]);
  if (result.code !== 0) {
    throw new Error(`morpho query-vaults failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  const parsed = JSON.parse(result.stdout) as { vaults?: MorphoVaultSummary[] };
  const vaults = parsed.vaults ?? [];
  return vaults.filter((vault) => vault.asset?.symbol === "USDC");
}

function pickTopVaults(vaults: MorphoVaultSummary[], count: number): MorphoVaultSummary[] {
  return [...vaults]
    .filter((vault) => Number(vault.tvlUsd ?? "0") > 0)
    .sort((left, right) => Number(right.tvlUsd ?? "0") - Number(left.tvlUsd ?? "0"))
    .slice(0, count);
}

async function writeValidationProfile(
  settings: VaultManagerSettings,
  _vaults: MorphoVaultSummary[]
): Promise<VaultManagerProfile> {
  const profile: VaultManagerProfile = {
    profileId: "live-path",
    chain: "base",
    walletRef: "live-path-wallet",
    walletAddress: LIVE_VALIDATION_WALLET,
    walletMode: "existing",
    riskProfile: "balanced",
    tokenEnvVar: "OWS_LIVE_PATH_TOKEN",
    tokenSource: { kind: "env", envVar: "OWS_LIVE_PATH_TOKEN" },
    usdcAddress: BASE_USDC_ADDRESS,
    agentId: "vault-manager-live-path",
    workspaceDir: path.join(settings.workspaceRoot, "workspace-live-path"),
    cronJobId: undefined,
    cronJobName: "Live Path Validation",
    cronExpression: "0 */6 * * *",
    timezone: "UTC",
    notifications: "none",
    cronEnabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    riskPreset: RISK_PRESETS.balanced
  };
  await saveProfile(settings, profile);
  return profile;
}

async function safeStep(
  id: string,
  description: string,
  fn: () => Promise<string | void>
): Promise<StepResult> {
  try {
    const detail = await fn();
    return {
      id,
      status: "pass",
      description,
      detail: detail ?? undefined
    };
  } catch (error) {
    return {
      id,
      status: "fail",
      description,
      detail: (error as Error).message
    };
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const baseSettings = resolveVaultManagerSettings();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-manager-live-"));
  const settings: VaultManagerSettings = {
    ...baseSettings,
    dataRoot: root,
    workspaceRoot: path.join(root, "workspace"),
    defaultProfilePath: path.join(root, "profiles", "default.json")
  };
  await fs.mkdir(path.dirname(settings.defaultProfilePath), { recursive: true });

  const steps: StepResult[] = [];

  try {
    steps.push(
      await safeStep("preflight", "Preflight checks", async () => {
        const result = await runPreflightChecks(settings);
        if (!result.ok) {
          throw new Error(result.issues.map((issue) => issue.message).join("; "));
        }
        return "openclaw, ows, morpho-cli, gateway all healthy";
      })
    );

    steps.push(
      await safeStep("openclaw-version", "openclaw --version", async () => {
        const { stdout } = await execFileAsync("openclaw", ["--version"], { timeout: 10_000 });
        return stdout.trim().split("\n").slice(0, 2).join(" | ");
      })
    );

    steps.push(
      await safeStep("ows-version", "ows --version", async () => {
        const { stdout } = await execFileAsync("ows", ["--version"], { timeout: 10_000 });
        return stdout.trim();
      })
    );

    steps.push(
      await safeStep("morpho-health", "morpho-cli health-check", async () => {
        const healthy = await runMorphoHealthCheck(settings);
        if (!healthy) throw new Error("morpho health-check returned non-zero");
        return "operational";
      })
    );

    steps.push(
      await safeStep("gateway-status", "openclaw gateway status", async () => {
        const reachable = await openclawGatewayIsReachable(settings);
        if (!reachable) throw new Error("openclaw gateway status returned non-zero");
        return "reachable";
      })
    );

    let chosenVaults: MorphoVaultSummary[] = [];
    steps.push(
      await safeStep("query-vaults", "morpho query-vaults (Base USDC)", async () => {
        const vaults = await queryBaseUsdcVaults(settings);
        chosenVaults = pickTopVaults(vaults, 2);
        if (chosenVaults.length === 0) {
          throw new Error("No Base USDC vaults with positive TVL returned");
        }
        return `top ${chosenVaults.length}: ${chosenVaults
          .map((vault) => `${vault.name}(${vault.tvlUsd} TVL)`)
          .join(", ")}`;
      })
    );

    steps.push(
      await safeStep("get-vault", "morpho get-vault for each selected", async () => {
        for (const vault of chosenVaults) {
          const detail = await getMorphoVault(settings, "base", vault.address);
          if (detail.asset.symbol !== "USDC") {
            throw new Error(`Vault ${detail.address} is not USDC`);
          }
        }
        return `verified ${chosenVaults.length} vault(s)`;
      })
    );

    steps.push(
      await safeStep(
        "get-positions",
        `morpho get-positions ${LIVE_VALIDATION_WALLET}`,
        async () => {
          const positions = await getMorphoPositions(settings, "base", LIVE_VALIDATION_WALLET);
          return `${positions.vaultPositions.length} vault position(s), ${positions.marketPositions.length} market position(s)`;
        }
      )
    );

    steps.push(
      await safeStep(
        "get-token-balance",
        `morpho get-token-balance USDC ${LIVE_VALIDATION_WALLET}`,
        async () => {
          const balance = await getMorphoTokenBalance(
            settings,
            "base",
            BASE_USDC_ADDRESS,
            LIVE_VALIDATION_WALLET
          );
          return `${balance.balance.value} ${balance.balance.symbol}`;
        }
      )
    );

    let dryRunStatus = "";
    steps.push(
      await safeStep("dry-run-rebalance", "runRebalance dry-run against live Morpho", async () => {
        const profile = await writeValidationProfile(settings, chosenVaults);
        const result = await runRebalance(settings, profile.profileId, "dry-run");
        dryRunStatus = result.status;
        const expectedStatuses = new Set(["no_op", "planned", "blocked"]);
        if (!expectedStatuses.has(result.status)) {
          throw new Error(`Unexpected status ${result.status}`);
        }
        return `status=${result.status} receipt=${result.receiptPath} log=${result.logPath}`;
      })
    );

    steps.push(
      await safeStep("live-refusal", "live-run refuses without arming", async () => {
        const cliResult = await runCommand("npx", [
          "tsx",
          path.resolve(new URL("./rebalance.ts", import.meta.url).pathname),
          "live",
          "--profile",
          "live-path"
        ]);
        if (cliResult.code === 0) {
          throw new Error("live runner did not refuse without --allow-live");
        }
        if (!/allow-live/i.test(`${cliResult.stdout}${cliResult.stderr}`)) {
          throw new Error(`live refusal message missing --allow-live hint: ${cliResult.stderr}`);
        }
        return "refused as expected";
      })
    );

    const failed = steps.filter((step) => step.status === "fail");
    const report = {
      root,
      dryRunStatus,
      totals: {
        pass: steps.length - failed.length,
        fail: failed.length
      },
      steps
    };

    if (args.format === "json") {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`[live-path] sandbox root ${root}\n`);
      for (const step of steps) {
        process.stdout.write(
          `[live-path] ${step.status.padEnd(4)} ${step.id} — ${step.description}${
            step.detail ? ` (${step.detail})` : ""
          }\n`
        );
      }
      process.stdout.write(
        `[live-path] summary pass=${report.totals.pass} fail=${report.totals.fail}\n`
      );
    }

    if (failed.length > 0) {
      process.exit(1);
    }
  } finally {
    if (!args.keep) {
      await fs.rm(root, { recursive: true, force: true });
    } else {
      process.stdout.write(`[live-path] kept sandbox at ${root}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[live-path] ${(error as Error).stack ?? (error as Error).message}\n`);
  process.exitCode = 1;
});
