import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BASE_USDC_ADDRESS, RISK_PRESETS } from "../lib/constants.js";
import {
  FIXTURE_VAULT_A,
  FIXTURE_VAULT_B,
  FIXTURE_WALLET,
  makeFixturePlanDeps
} from "../lib/fixtures.js";
import { saveProfile } from "../lib/profile.js";
import { runPlan } from "../lib/rebalance.js";
import type { VaultManagerProfile, VaultManagerSettings } from "../lib/types.js";

type SandboxArgs = {
  keep: boolean;
  scenario: "planned" | "no-op" | "blocked";
  format: "text" | "json";
};

function parseArgs(argv: string[]): SandboxArgs {
  const args: SandboxArgs = { keep: false, scenario: "planned", format: "text" };
  for (const arg of argv) {
    if (arg === "--keep") args.keep = true;
    else if (arg === "--scenario=no-op" || arg === "--scenario=noop") args.scenario = "no-op";
    else if (arg === "--scenario=blocked") args.scenario = "blocked";
    else if (arg === "--scenario=planned") args.scenario = "planned";
    else if (arg === "--format=json") args.format = "json";
    else if (arg === "--format=text") args.format = "text";
  }
  return args;
}

function makeSandboxSettings(root: string): VaultManagerSettings {
  return {
    dataRoot: root,
    workspaceRoot: path.join(root, "workspace"),
    defaultProfilePath: path.join(root, "profiles", "default.json"),
    owsCommand: "ows",
    openclawCommand: "openclaw",
    morphoCliCommand: "bunx",
    morphoCliArgsPrefix: ["--package", "@morpho-org/cli", "morpho"],
    defaultChain: "base",
    defaultCron: "0 */6 * * *",
    defaultTimezone: "UTC",
    defaultDeliveryMode: "announce",
    defaultDeliveryChannel: "last",
    defaultTokenEnvVar: "OWS_MORPHO_VAULT_MANAGER_TOKEN",
    defaultTokenSource: {
      kind: "env",
      envVar: "OWS_MORPHO_VAULT_MANAGER_TOKEN"
    },
    baseAgentId: "vault-manager",
    baseCronName: "Morpho Vault Rebalance",
  };
}

async function makeSandboxProfile(
  settings: VaultManagerSettings,
  scenario: SandboxArgs["scenario"]
): Promise<VaultManagerProfile> {
  const riskPreset = RISK_PRESETS.balanced;
  const profile: VaultManagerProfile = {
    profileId: `sandbox-${scenario}`,
    chain: "base",
    walletRef: `sandbox-wallet-${scenario}`,
    walletAddress: FIXTURE_WALLET,
    walletMode: "existing",
    riskProfile: "balanced",
    tokenEnvVar: "OWS_SANDBOX_TOKEN",
    tokenSource: { kind: "env", envVar: "OWS_SANDBOX_TOKEN" },
    usdcAddress: BASE_USDC_ADDRESS,
    agentId: `vault-manager-sandbox-${scenario}`,
    workspaceDir: path.join(settings.workspaceRoot, `workspace-sandbox-${scenario}`),
    cronJobId: undefined,
    cronJobName: `Sandbox ${scenario}`,
    cronExpression: "0 */6 * * *",
    timezone: "UTC",
    notifications: "none",
    deliveryChannel: undefined,
    deliveryTo: undefined,
    deliveryAccountId: undefined,
    cronEnabled: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    riskPreset
  };

  await saveProfile(settings, profile);
  return profile;
}

function depsForScenario(scenario: SandboxArgs["scenario"]) {
  if (scenario === "no-op") {
    // Zero idle and no positions — nothing to allocate.
    return makeFixturePlanDeps({
      positions: [],
      idleUsdc: "0"
    });
  }
  if (scenario === "blocked") {
    // Idle amount large enough that planned turnover exceeds the risk preset's maxTurnoverUsd cap.
    return makeFixturePlanDeps({
      idleUsdc: "100000"
    });
  }
  return makeFixturePlanDeps({ idleUsdc: "5000" });
}

async function cleanup(root: string): Promise<void> {
  try {
    await fs.rm(root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vault-manager-sandbox-"));
  const settings = makeSandboxSettings(root);
  await fs.mkdir(path.dirname(settings.defaultProfilePath), { recursive: true });

  try {
    const profile = await makeSandboxProfile(settings, args.scenario);
    const deps = depsForScenario(args.scenario);
    const result = await runPlan(settings, profile.profileId, deps);

    const report = {
      scenario: args.scenario,
      status: result.status,
      sandboxRoot: root,
      receiptPath: result.receiptPath,
      logPath: result.logPath,
      metrics: result.metrics,
      actionCount: result.actions.length,
      reasons: result.reasons
    };

    if (args.format === "json") {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`[sandbox] scenario=${report.scenario} status=${report.status}\n`);
      process.stdout.write(`[sandbox] root=${report.sandboxRoot}\n`);
      process.stdout.write(`[sandbox] receipt=${report.receiptPath}\n`);
      process.stdout.write(`[sandbox] log=${report.logPath}\n`);
      process.stdout.write(`[sandbox] managed USDC=${report.metrics.totalManagedUsdc}\n`);
      process.stdout.write(`[sandbox] idle USDC=${report.metrics.idleUsdc}\n`);
      process.stdout.write(`[sandbox] planned turnover=${report.metrics.totalPlannedTurnoverUsdc}\n`);
      process.stdout.write(`[sandbox] actions=${report.actionCount}\n`);
      if (report.reasons.length > 0) {
        process.stdout.write(`[sandbox] reasons:\n`);
        for (const reason of report.reasons) process.stdout.write(`  - ${reason}\n`);
      }
    }

    const expectedStatus =
      args.scenario === "planned"
        ? "planned"
        : args.scenario === "no-op"
        ? "no_op"
        : "blocked";
    if (result.status !== expectedStatus) {
      throw new Error(
        `Expected sandbox scenario ${args.scenario} to produce status ${expectedStatus}, got ${result.status}`
      );
    }
  } finally {
    if (!args.keep) {
      await cleanup(root);
    } else {
      process.stdout.write(`[sandbox] kept sandbox root at ${root}\n`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`[sandbox] ${(error as Error).stack ?? (error as Error).message}\n`);
  process.exitCode = 1;
});
