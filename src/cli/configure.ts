import path from "node:path";
import * as p from "@clack/prompts";
import { getAddress, isAddress } from "viem";
import { BASE_USDC_ADDRESS, RISK_PRESETS } from "../lib/constants.js";
import { ensureDir, writeTextFile } from "../lib/fs.js";
import { runMorphoHealthCheck } from "../lib/morpho.js";
import { disableCronJob, enableCronJob, ensureAgent, listCronJobs, openclawGatewayIsReachable, runCronJobNow, upsertCronJob } from "../lib/openclaw.js";
import { writePolicyArtifacts } from "../lib/policy.js";
import { runRebalance, type RebalanceRunResult } from "../lib/rebalance.js";
import { buildApiKeyCreateCommand, buildWalletCreateCommand, runOwsPolicyCreate } from "../lib/ows.js";
import { loadProfile, saveProfile } from "../lib/profile.js";
import { commandExists } from "../lib/shell.js";
import { renderAgentInstructions } from "../lib/template.js";
import type { CliLogger, ConfigureResult, VaultManagerProfile, VaultManagerSettings } from "../lib/types.js";

type ConfigureContext = {
  settings: VaultManagerSettings;
  logger?: CliLogger;
  profileId: string;
};

function fail(message: string): never {
  p.cancel(message);
  throw new Error(message);
}

function requiredString(value: string | symbol | null | undefined, label: string): string {
  if (value === undefined || value === null || typeof value === "symbol" || value.trim().length === 0) {
    fail(`${label} is required.`);
  }
  return value.trim();
}

function optionalString(value: string | symbol | null | undefined): string {
  if (value === undefined || value === null || typeof value === "symbol") {
    return "";
  }
  return value.trim();
}

function requiredBoolean(value: boolean | symbol | undefined, label: string): boolean {
  if (typeof value === "symbol" || value === undefined) {
    fail(`${label} was cancelled.`);
  }
  return value;
}

function parseAddressList(input: string): string[] {
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (!isAddress(value)) {
        fail(`Invalid address: ${value}`);
      }
      return getAddress(value);
    });
}

function tokenEnvVarForProfile(settings: VaultManagerSettings, profileId: string): string {
  if (profileId === "default") {
    return settings.defaultTokenEnvVar;
  }

  const suffix = profileId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return `${settings.defaultTokenEnvVar}_${suffix}`;
}

function agentIdForProfile(settings: VaultManagerSettings, profileId: string): string {
  return profileId === "default" ? settings.baseAgentId : `${settings.baseAgentId}-${profileId}`;
}

function workspaceDirForAgent(settings: VaultManagerSettings, agentId: string): string {
  return path.join(settings.workspaceRoot, `workspace-${agentId}`);
}

async function preflight(settings: VaultManagerSettings): Promise<void> {
  const checks = await Promise.all([
    commandExists(settings.openclawCommand),
    commandExists(settings.owsCommand),
    commandExists(settings.morphoCliCommand)
  ]);

  if (!checks[0]) fail(`Missing required command: ${settings.openclawCommand}`);
  if (!checks[1]) fail(`Missing required command: ${settings.owsCommand}`);
  if (!checks[2]) fail(`Missing required command: ${settings.morphoCliCommand}`);

  const morphoOk = await runMorphoHealthCheck(settings);
  if (!morphoOk) {
    fail("morpho-cli health-check failed. Fix the Morpho CLI before configuring the vault manager.");
  }

  const gatewayOk = await openclawGatewayIsReachable(settings);
  if (!gatewayOk) {
    fail(
      "OpenClaw gateway is not reachable. Cron runs inside the gateway process, so start the gateway before running configure."
    );
  }
}

async function promptWallet(existing?: VaultManagerProfile, settings?: VaultManagerSettings): Promise<{
  walletMode: "created" | "existing";
  walletRef: string;
  walletAddress: string;
}> {
  const walletMode = await p.select({
    message: "Wallet setup",
    initialValue: existing?.walletMode ?? "created",
    options: [
      {
        value: "created",
        label: "Create a fresh OWS wallet",
        hint: "Guided, but the sensitive OWS command still runs under your control."
      },
      {
        value: "existing",
        label: "Use an existing OWS wallet",
        hint: "Use a wallet that already exists inside OWS."
      }
    ]
  });

  const resolvedMode = requiredString(walletMode, "wallet mode") as "created" | "existing";

  if (resolvedMode === "created") {
    const walletName = requiredString(
      await p.text({
        message: "Wallet name",
        placeholder: existing?.walletRef ?? `morpho-vault-manager`,
        defaultValue: existing?.walletRef ?? "morpho-vault-manager"
      }),
      "wallet name"
    );

    await p.note(
      `Run this command in another shell, complete the OWS prompts, then return here:\n\n${buildWalletCreateCommand(
        settings!,
        walletName
      )}`,
      "Create Wallet"
    );

    const created = requiredBoolean(await p.confirm({
      message: "Did you create the wallet successfully?",
      initialValue: true
    }), "wallet creation confirmation");

    if (!created) {
      fail("Wallet creation was not completed.");
    }

    const walletRef = walletName;
    const walletAddress = requiredString(
      await p.text({
        message: "Wallet public address",
        placeholder: existing?.walletAddress ?? "0x...",
        defaultValue: existing?.walletAddress ?? "",
        validate(value) {
          return isAddress(value) ? undefined : "Enter a valid EVM address.";
        }
      }),
      "wallet public address"
    );

    return {
      walletMode: resolvedMode,
      walletRef,
      walletAddress: getAddress(walletAddress)
    };
  }

  const walletRef = requiredString(
    await p.text({
      message: "Existing OWS wallet reference",
      placeholder: existing?.walletRef ?? "wallet-name-or-id",
      defaultValue: existing?.walletRef ?? ""
    }),
    "wallet reference"
  );

  const walletAddress = requiredString(
    await p.text({
      message: "Existing wallet public address",
      placeholder: existing?.walletAddress ?? "0x...",
      defaultValue: existing?.walletAddress ?? "",
      validate(value) {
        return isAddress(value) ? undefined : "Enter a valid EVM address.";
      }
    }),
    "wallet public address"
  );

  return {
    walletMode: resolvedMode,
    walletRef,
    walletAddress: getAddress(walletAddress)
  };
}

export async function runConfigureFlow(context: ConfigureContext): Promise<ConfigureResult> {
  const { settings, profileId } = context;
  const existing = await loadProfile(settings, profileId);

  p.intro(`Morpho Vault Manager configure (${profileId})`);

  await preflight(settings);

  const wallet = await promptWallet(existing.profile ?? undefined, settings);

  const backedUp = requiredBoolean(await p.confirm({
    message: "Have you backed up the wallet recovery material and confirmed you understand the owner credential must stay out of the agent?",
    initialValue: false
  }), "backup confirmation");

  if (!backedUp) {
    fail("Backup confirmation is required.");
  }

  const riskProfile = requiredString(
    await p.select({
      message: "Risk profile",
      initialValue: existing.profile?.riskProfile ?? "balanced",
      options: Object.values(RISK_PRESETS).map((preset) => ({
        value: preset.id,
        label: preset.label,
        hint: preset.description
      }))
    }),
    "risk profile"
  ) as keyof typeof RISK_PRESETS;

  const vaultsInput = optionalString(
    await p.text({
      message: "Allowed vault addresses (comma-separated, leave blank for dry-run-only mode)",
      placeholder: existing.profile?.allowedVaults.join(", ") ?? "",
      defaultValue: existing.profile?.allowedVaults.join(", ") ?? ""
    })
  );

  const allowedVaults = vaultsInput.length > 0 ? parseAddressList(vaultsInput) : [];
  const spendersInput = optionalString(
    await p.text({
      message: "Additional allowed spender addresses (optional, comma-separated)",
      placeholder: existing.profile?.allowedSpenders.join(", ") ?? "",
      defaultValue: existing.profile?.allowedSpenders.join(", ") ?? ""
    })
  );
  const allowedSpenders = spendersInput.length > 0 ? parseAddressList(spendersInput) : allowedVaults;

  const notifications = requiredString(
    await p.select({
      message: "Cron delivery mode",
      initialValue: existing.profile?.notifications ?? "announce",
      options: [
        { value: "announce", label: "Announce run summaries", hint: "Post run summaries back through OpenClaw." },
        { value: "none", label: "No delivery", hint: "Keep cron runs internal only." }
      ]
    }),
    "cron delivery mode"
  ) as "announce" | "none";

  const cronExpression = requiredString(
    await p.text({
      message: "Cron expression",
      placeholder: settings.defaultCron,
      defaultValue: existing.profile?.cronExpression ?? settings.defaultCron
    }),
    "cron expression"
  );

  const timezone = requiredString(
    await p.text({
      message: "Cron timezone",
      placeholder: settings.defaultTimezone,
      defaultValue: existing.profile?.timezone ?? settings.defaultTimezone
    }),
    "cron timezone"
  );

  const riskPreset = RISK_PRESETS[riskProfile];
  const tokenEnvVar = tokenEnvVarForProfile(settings, profileId);
  const agentId = agentIdForProfile(settings, profileId);
  const workspaceDir = workspaceDirForAgent(settings, agentId);
  const cronEnabled = requiredBoolean(await p.confirm({
    message: "Enable the cron job immediately?",
    initialValue: existing.profile?.cronEnabled ?? false
  }), "cron enable confirmation");

  const policyArtifacts = await writePolicyArtifacts({
    settings,
    profileId,
    allowedVaults,
    allowedSpenders,
    usdcAddress: BASE_USDC_ADDRESS,
    riskPreset
  });

  const policyCreation = await runOwsPolicyCreate(settings, policyArtifacts.policyFilePath);
  const createdPolicy = policyCreation.ok;

  if (!policyCreation.ok) {
    await p.note(
      `Automatic policy creation failed.\n\nRun this manually and rerun configure if needed:\n${settings.owsCommand} policy create --file "${policyArtifacts.policyFilePath}"\n\nstderr:\n${policyCreation.stderr || "(empty)"}`,
      "OWS Policy"
    );
  }

  await p.note(
    [
      "Create the OWS API key manually so the token never passes through the plugin process.",
      "",
      buildApiKeyCreateCommand({
        settings,
        keyName: `${agentId}-agent`,
        walletRef: wallet.walletRef,
        policyId: policyArtifacts.policyId
      }),
      "",
      `Store the returned token securely and inject it into the OpenClaw gateway environment as ${tokenEnvVar}.`
    ].join("\n"),
    "OWS API Key"
  );

  const tokenProvisioned = requiredBoolean(await p.confirm({
    message: `Have you provisioned ${tokenEnvVar} into the environment used by the OpenClaw gateway?`,
    initialValue: false
  }), "token provisioning confirmation");

  if (!tokenProvisioned) {
    fail("OWS API token provisioning is required before finishing configure.");
  }

  await ensureDir(workspaceDir);

  const profile: VaultManagerProfile = {
    profileId,
    chain: "base",
    walletRef: wallet.walletRef,
    walletAddress: wallet.walletAddress,
    walletMode: wallet.walletMode,
    riskProfile,
    allowedVaults,
    allowedSpenders,
    tokenEnvVar,
    usdcAddress: BASE_USDC_ADDRESS,
    policyId: policyArtifacts.policyId,
    policyFile: policyArtifacts.policyFilePath,
    policyExecutable: policyArtifacts.executablePath,
    agentId,
    workspaceDir,
    cronJobId: existing.profile?.cronJobId,
    cronJobName: existing.profile?.cronJobName ?? `${settings.baseCronName} (${profileId})`,
    cronExpression,
    timezone,
    notifications,
    cronEnabled,
    createdAt: existing.profile?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    notes:
      allowedVaults.length === 0
        ? "No live vault allowlist configured. The profile should remain dry-run-only until vault addresses are added."
        : undefined,
    riskPreset
  };

  await writeTextFile(path.join(workspaceDir, "AGENTS.md"), renderAgentInstructions(profile));

  const agentResult = await ensureAgent({
    settings,
    agentId,
    workspaceDir
  });

  if (!agentResult.ok) {
    fail(`Failed to create or resolve OpenClaw agent ${agentId}.\n${agentResult.stderr || agentResult.stdout}`);
  }

  const cronResult = await upsertCronJob({
    settings,
    profile
  });

  if (!cronResult.ok || !cronResult.jobId) {
    fail(`Failed to create or update the cron job.\n${cronResult.stderr || cronResult.stdout}`);
  }

  profile.cronJobId = cronResult.jobId;

  const profilePath = await saveProfile(settings, profile);

  await p.note(
    [
      `Profile: ${profilePath}`,
      `Workspace: ${workspaceDir}`,
      `Agent: ${agentId}`,
      `Cron job: ${profile.cronJobId}`,
      `Token env var: ${tokenEnvVar}`
    ].join("\n"),
    "Configured"
  );

  p.outro("Vault manager configuration complete.");

  return {
    profile,
    profilePath,
    createdPolicy,
    createdAgent: agentResult.created,
    createdCron: cronResult.created
  };
}

export async function showStatus(settings: VaultManagerSettings, profileId: string, json: boolean): Promise<void> {
  const { profile } = await loadProfile(settings, profileId);
  if (!profile) {
    fail(`Profile ${profileId} does not exist.`);
  }

  const cronJobs = await listCronJobs(settings);
  const cronJob = cronJobs?.find((job) => {
    const id = typeof (job as { id?: unknown }).id === "string" ? (job as { id: string }).id : undefined;
    return id === profile.cronJobId;
  });

  const summary = {
    profileId: profile.profileId,
    walletRef: profile.walletRef,
    walletAddress: profile.walletAddress,
    riskProfile: profile.riskProfile,
    allowedVaults: profile.allowedVaults,
    tokenEnvVar: profile.tokenEnvVar,
    tokenEnvVarPresentInCurrentShell: Boolean(process.env[profile.tokenEnvVar]),
    agentId: profile.agentId,
    workspaceDir: profile.workspaceDir,
    cronJobId: profile.cronJobId,
    cronKnownToGateway: Boolean(cronJob),
    cronEnabled: profile.cronEnabled,
    notifications: profile.notifications,
    policyId: profile.policyId,
    updatedAt: profile.updatedAt
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  await p.note(
    [
      `Wallet: ${summary.walletRef} (${summary.walletAddress})`,
      `Risk profile: ${summary.riskProfile}`,
      `Allowed vaults: ${summary.allowedVaults.length}`,
      `Token env var: ${summary.tokenEnvVar} (${summary.tokenEnvVarPresentInCurrentShell ? "present in current shell" : "not present in current shell"})`,
      `Agent: ${summary.agentId}`,
      `Workspace: ${summary.workspaceDir}`,
      `Cron job: ${summary.cronJobId ?? "missing"} (${summary.cronKnownToGateway ? "known" : "not found"})`,
      `Cron enabled: ${summary.cronEnabled ? "yes" : "no"}`,
      `Policy: ${summary.policyId}`
    ].join("\n"),
    `Status: ${profile.profileId}`
  );
}

export async function pauseProfile(settings: VaultManagerSettings, profileId: string): Promise<void> {
  const loaded = await loadProfile(settings, profileId);
  const profile = loaded.profile;
  if (!profile || !profile.cronJobId) {
    fail(`Profile ${profileId} does not have a cron job.`);
  }

  const ok = await disableCronJob(settings, profile.cronJobId);
  if (!ok) {
    fail(`Failed to disable cron job ${profile.cronJobId}.`);
  }

  profile.cronEnabled = false;
  profile.updatedAt = new Date().toISOString();
  await saveProfile(settings, profile);
  p.outro(`Paused ${profileId}.`);
}

export async function resumeProfile(settings: VaultManagerSettings, profileId: string): Promise<void> {
  const loaded = await loadProfile(settings, profileId);
  const profile = loaded.profile;
  if (!profile || !profile.cronJobId) {
    fail(`Profile ${profileId} does not have a cron job.`);
  }

  const ok = await enableCronJob(settings, profile.cronJobId);
  if (!ok) {
    fail(`Failed to enable cron job ${profile.cronJobId}.`);
  }

  profile.cronEnabled = true;
  profile.updatedAt = new Date().toISOString();
  await saveProfile(settings, profile);
  p.outro(`Resumed ${profileId}.`);
}

export async function runProfileNow(settings: VaultManagerSettings, profileId: string): Promise<void> {
  const loaded = await loadProfile(settings, profileId);
  const profile = loaded.profile;
  if (!profile || !profile.cronJobId) {
    fail(`Profile ${profileId} does not have a cron job.`);
  }

  const output = await runCronJobNow(settings, profile.cronJobId);
  await p.note(output || "Run enqueued.", `Run Now: ${profileId}`);
}

function renderRunSummary(result: RebalanceRunResult): string {
  const lines = [
    `Status: ${result.status}`,
    `Mode: ${result.mode}`,
    `Wallet: ${result.walletAddress}`,
    `Managed USDC: ${result.metrics.totalManagedUsdc}`,
    `Idle USDC: ${result.metrics.idleUsdc}`,
    `Planned turnover: ${result.metrics.totalPlannedTurnoverUsdc}`,
    `Receipt: ${result.receiptPath}`
  ];

  if (result.actions.length > 0) {
    lines.push("");
    lines.push("Actions:");
    for (const action of result.actions) {
      lines.push(`- ${action.kind} ${action.amountUsdc} USDC via ${action.vaultName} (${action.vaultAddress})`);
    }
  }

  if (result.reasons.length > 0) {
    lines.push("");
    lines.push("Reasons:");
    for (const reason of result.reasons) {
      lines.push(`- ${reason}`);
    }
  }

  if (result.execution.transactions.length > 0) {
    lines.push("");
    lines.push("Receipts:");
    for (const tx of result.execution.transactions) {
      lines.push(`- ${tx.hash} (${tx.description})`);
    }
  }

  return lines.join("\n");
}

async function presentRunResult(result: RebalanceRunResult, json: boolean, title: string): Promise<void> {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  await p.note(renderRunSummary(result), title);
}

export async function runProfileDryRun(
  settings: VaultManagerSettings,
  profileId: string,
  json: boolean
): Promise<void> {
  const result = await runRebalance(settings, profileId, "dry-run");
  await presentRunResult(result, json, `Dry Run: ${profileId}`);
}

export async function runProfileLive(
  settings: VaultManagerSettings,
  profileId: string,
  json: boolean,
  allowLive: boolean
): Promise<void> {
  if (!allowLive) {
    fail("Live execution requires --allow-live.");
  }

  const result = await runRebalance(settings, profileId, "live");
  await presentRunResult(result, json, `Live Run: ${profileId}`);
}
