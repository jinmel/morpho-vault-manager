import path from "node:path";
import * as p from "@clack/prompts";
import {
  BASE_USDC_ADDRESS,
  RISK_PRESETS
} from "../lib/constants.js";
import { ensureDir, readTextFile, writeTextFile } from "../lib/fs.js";
import { getMorphoTokenBalance } from "../lib/morpho.js";
import { describeTokenSource, resolveApiToken, type TokenSource } from "../lib/secrets.js";
import {
  disableCronJob,
  enableCronJob,
  ensureAgent,
  getDefaultModel,
  installSkill,
  listConfiguredTelegramAccounts,
  listCronJobs,
  listTelegramGroups,
  runCronJobNow,
  upsertCronJob
} from "../lib/openclaw.js";
import { runPreflightChecks } from "../lib/preflight.js";
import {
  canonicalWalletName,
  deleteWalletMarker,
  ensureOwsInstalled,
  inspectWalletStatus,
  provisionApiKey,
  resolveOrCreateWallet,
  walletMarkerPath,
  writeWalletMarker,
  writeTokenToOpenclawEnv
} from "../lib/ows-bootstrap.js";
import { runPlan, type PlanResult } from "../lib/rebalance.js";
import { loadProfile, saveProfile } from "../lib/profile.js";
import { renderAgentInstructions } from "../lib/template.js";
import type {
  CliLogger,
  ConfigureResult,
  RiskPreset,
  VaultManagerProfile,
  VaultManagerSettings
} from "../lib/types.js";

type ConfigureContext = {
  settings: VaultManagerSettings;
  logger?: CliLogger;
  profileId: string;
  walletOverrideRef?: string;
  walletPassphraseEnvVar?: string;
};

type CronSchedulePresetId = "hourly" | "every6Hours" | "daily" | "weekdays";
type CronScheduleSelection = CronSchedulePresetId | "custom";
type DeliveryTargetSelection = "last" | "telegram" | "manual";

type CronSchedulePreset = {
  id: CronSchedulePresetId;
  label: string;
  cronExpression: string;
  description: string;
};

export const CRON_SCHEDULE_PRESETS: Record<CronSchedulePresetId, CronSchedulePreset> = {
  hourly: {
    id: "hourly",
    label: "Hourly",
    cronExpression: "0 * * * *",
    description: "Run once per hour at minute 0."
  },
  every6Hours: {
    id: "every6Hours",
    label: "Every 6 hours",
    cronExpression: "0 */6 * * *",
    description: "Run four times per day on a 6 hour cadence."
  },
  daily: {
    id: "daily",
    label: "Daily",
    cronExpression: "0 0 * * *",
    description: "Run once per day at midnight."
  },
  weekdays: {
    id: "weekdays",
    label: "Weekdays",
    cronExpression: "0 0 * * 1-5",
    description: "Run Monday through Friday at midnight."
  }
};

export function formatRiskPresetConfig(riskPreset: RiskPreset): string {
  return JSON.stringify(riskPreset, null, 2);
}

export function describeCronSchedule(cronExpression: string): string {
  const preset = Object.values(CRON_SCHEDULE_PRESETS).find(
    (candidate) => candidate.cronExpression === cronExpression
  );
  return preset ? `${preset.label} (${preset.cronExpression})` : `Custom (${cronExpression})`;
}

function cronScheduleSelectionForExpression(expression: string): CronScheduleSelection {
  const preset = Object.values(CRON_SCHEDULE_PRESETS).find(
    (candidate) => candidate.cronExpression === expression
  );
  return preset ? preset.id : "custom";
}

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

function tokenEnvVarForProfile(settings: VaultManagerSettings, profileId: string): string {
  if (profileId === "default") {
    return settings.defaultTokenEnvVar;
  }

  const suffix = profileId.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  return `${settings.defaultTokenEnvVar}_${suffix}`;
}

export function agentIdForProfile(settings: VaultManagerSettings, profileId: string): string {
  return profileId === "default" ? settings.baseAgentId : `${settings.baseAgentId}-${profileId}`;
}

export function workspaceDirForAgent(settings: VaultManagerSettings, agentId: string): string {
  return path.join(settings.workspaceRoot, `workspace-${agentId}`);
}

function describeDeliveryTarget(target: {
  notifications: "announce" | "none";
  deliveryChannel?: string;
  deliveryTo?: string;
  deliveryAccountId?: string;
}): string {
  if (target.notifications !== "announce") {
    return "Internal only (no delivery)";
  }
  if ((target.deliveryChannel ?? "last") === "last") {
    return "Announce to OpenClaw last route";
  }

  const pieces = [target.deliveryChannel];
  if (target.deliveryTo) {
    pieces.push(target.deliveryTo);
  }
  if (target.deliveryAccountId) {
    pieces.push(`account ${target.deliveryAccountId}`);
  }
  return pieces.join(" / ");
}

async function promptTelegramDeliveryTarget(
  settings: VaultManagerSettings,
  existing?: { deliveryTo?: string; deliveryAccountId?: string }
): Promise<{ deliveryChannel: string; deliveryTo?: string; deliveryAccountId?: string }> {
  const accounts = await listConfiguredTelegramAccounts(settings);
  if (accounts.length === 0) {
    await p.note(
      [
        "No configured Telegram accounts were found in OpenClaw.",
        "Falling back to the OpenClaw last route instead of asking for a raw chat id."
      ].join("\n"),
      "Telegram Delivery"
    );
    return { deliveryChannel: "last" };
  }

  const defaultAccountId = existing?.deliveryAccountId ?? settings.defaultDeliveryAccountId;
  let accountId =
    accounts.length === 1 ? accounts[0] : accounts.includes(defaultAccountId ?? "") ? defaultAccountId : undefined;

  if (accounts.length > 1) {
    accountId = requiredString(
      await p.select({
        message: "Telegram account",
        initialValue: accountId,
        options: accounts.map((candidate) => ({
          value: candidate,
          label: candidate,
          hint: "Configured Telegram account"
        }))
      }),
      "telegram account"
    );
  }

  const discoveredTargets = await listTelegramGroups(settings, accountId);
  if (discoveredTargets.length === 0) {
    await p.note(
      [
        "No Telegram groups/topics were discovered from the OpenClaw directory.",
        "Falling back to the OpenClaw last route instead of asking for a raw chat id."
      ].join("\n"),
      "Telegram Delivery"
    );
    return { deliveryChannel: "last" };
  }

  const deliveryTo = requiredString(
    await p.select({
      message: "Telegram delivery target",
      initialValue:
        discoveredTargets.some((target) => target.id === existing?.deliveryTo)
          ? existing?.deliveryTo
          : undefined,
      options: discoveredTargets.map((target) => ({
        value: target.id,
        label: target.label,
        hint: target.id
      }))
    }),
    "telegram delivery target"
  );

  return {
    deliveryChannel: "telegram",
    deliveryTo,
    deliveryAccountId: accountId
  };
}

async function promptManualDeliveryTarget(
  existing?: { deliveryChannel?: string; deliveryTo?: string; deliveryAccountId?: string }
): Promise<{ deliveryChannel: string; deliveryTo?: string; deliveryAccountId?: string }> {
  const deliveryChannel = requiredString(
    await p.text({
      message: "Delivery channel",
      placeholder: "telegram",
      defaultValue:
        existing?.deliveryChannel && existing.deliveryChannel !== "last"
          ? existing.deliveryChannel
          : undefined
    }),
    "delivery channel"
  );

  if (deliveryChannel === "last") {
    return { deliveryChannel: "last" };
  }

  const deliveryTo = requiredString(
    await p.text({
      message: "Delivery target",
      placeholder: "-1001234567890:topic:42",
      defaultValue: existing?.deliveryTo
    }),
    "delivery target"
  );

  const deliveryAccountId = optionalString(
    await p.text({
      message: "Delivery account id (optional)",
      placeholder: "default",
      defaultValue: existing?.deliveryAccountId
    })
  );

  return {
    deliveryChannel,
    deliveryTo,
    deliveryAccountId: deliveryAccountId || undefined
  };
}

async function promptCronDelivery(settings: VaultManagerSettings, existing?: VaultManagerProfile): Promise<{
  notifications: "announce" | "none";
  deliveryChannel?: string;
  deliveryTo?: string;
  deliveryAccountId?: string;
}> {
  const notifications = requiredString(
    await p.select({
      message: "Cron delivery mode",
      initialValue: existing?.notifications ?? settings.defaultDeliveryMode,
      options: [
        { value: "announce", label: "Announce run summaries", hint: "Publish run summaries back through OpenClaw." },
        { value: "none", label: "No delivery", hint: "Keep cron runs internal only." }
      ]
    }),
    "cron delivery mode"
  ) as "announce" | "none";

  if (notifications === "none") {
    return { notifications };
  }

  const existingSelection: DeliveryTargetSelection =
    existing?.deliveryChannel === "telegram"
      ? "telegram"
      : existing?.deliveryChannel && existing.deliveryChannel !== "last"
        ? "manual"
        : "last";
  const defaultSelection: DeliveryTargetSelection =
    settings.defaultDeliveryChannel && settings.defaultDeliveryChannel !== "last" ? "manual" : "last";

  const selection = requiredString(
    await p.select({
      message: "Cron delivery target",
      initialValue: existing ? existingSelection : defaultSelection,
      options: [
        {
          value: "last",
          label: "Use OpenClaw last route",
          hint: "Seamless default. Reuse the last chat destination OpenClaw delivered to."
        },
        {
          value: "telegram",
          label: "Select Telegram target",
          hint: "Discover Telegram groups/topics from OpenClaw and store one on this profile."
        },
        {
          value: "manual",
          label: "Manual target",
          hint: "Enter a delivery channel and destination yourself."
        }
      ]
    }),
    "cron delivery target"
  ) as DeliveryTargetSelection;

  if (selection === "last") {
    return {
      notifications,
      deliveryChannel: "last"
    };
  }

  if (selection === "telegram") {
    return {
      notifications,
      ...(await promptTelegramDeliveryTarget(settings, existing))
    };
  }

  return {
    notifications,
    ...(await promptManualDeliveryTarget(existing))
  };
}

async function preflight(settings: VaultManagerSettings): Promise<void> {
  const result = await runPreflightChecks(settings);
  const owsIssue = result.issues.find((issue) => issue.code === "missing_ows");
  const gatewayIssue = result.issues.find((issue) => issue.code === "openclaw_gateway_unreachable");
  const hardIssues = result.issues.filter(
    (issue) => issue.code !== "openclaw_gateway_unreachable" && issue.code !== "missing_ows"
  );

  if (hardIssues.length > 0) {
    fail(hardIssues.map((issue) => issue.message).join("\n"));
  }

  if (owsIssue) {
    const install = await ensureOwsInstalled(settings, {
      confirmInstall: async () =>
        requiredBoolean(
          await p.confirm({
            message: "OWS is not installed. Install it now via the official installer?",
            initialValue: true
          }),
          "OWS install confirmation"
        )
    });

    if (install.status === "declined") {
      fail("Install OWS before running configure. See https://docs.openwallet.sh/");
    }
    if (install.status === "failed") {
      fail(`OWS install failed: ${install.stderr ?? "unknown error"}`);
    }
    if (install.status === "path-stale") {
      fail(install.hint ?? "OWS installed but not on PATH; restart your shell and rerun.");
    }
    // install.status is "preexisting" (race) or "just-installed"; fall through.
  }

  if (gatewayIssue) {
    await p.note(
      [
        gatewayIssue.message,
        "",
        "Remediation:",
        ...(gatewayIssue.remediation ?? [
          "Start or daemonize the OpenClaw gateway before enabling cron.",
          "Verify the daemon with: openclaw gateway status",
          "Rerun configure after the gateway stays reachable."
        ]).map((line) => `- ${line}`),
        "",
        "Configure can continue for onboarding and profile creation, but cron setup will fail until the gateway is reachable."
      ].join("\n"),
      "Gateway Warning"
    );

    const continueAnyway = requiredBoolean(
      await p.confirm({
        message: "Continue configure without a reachable OpenClaw gateway?",
        initialValue: false
      }),
      "gateway continue confirmation"
    );

    if (!continueAnyway) {
      fail("Start the OpenClaw gateway daemon, then rerun configure.");
    }
  }
}


type FundingProbe = {
  balance: string;
  checkedAt: string;
} | null;

async function promptFundingGuidance(
  settings: VaultManagerSettings,
  walletAddress: string
): Promise<FundingProbe> {
  await p.note(
    [
      "Deposit USDC on Base to the wallet address below.",
      "",
      `Wallet: ${walletAddress}`,
      `Asset:  USDC (${BASE_USDC_ADDRESS})`,
      `Chain:  Base (eip155:8453)`,
      "",
      "Funding is optional right now; the rebalancer will no-op cleanly until USDC arrives."
    ].join("\n"),
    "Fund Wallet"
  );

  let lastProbe: FundingProbe = null;

  while (true) {
    const choice = requiredString(
      await p.select({
        message: "Funding check",
        initialValue: "check",
        options: [
          { value: "check", label: "Check current USDC balance now" },
          { value: "skip", label: "Skip funding check and continue" }
        ]
      }),
      "funding choice"
    );

    if (choice === "skip") {
      return lastProbe;
    }

    try {
      const balance = await getMorphoTokenBalance(
        settings,
        "base",
        BASE_USDC_ADDRESS,
        walletAddress
      );
      const amount = balance.balance.value;
      const checkedAt = new Date().toISOString();
      lastProbe = { balance: amount, checkedAt };

      await p.note(
        [
          `USDC balance: ${amount} ${balance.balance.symbol}`,
          `Checked at:   ${checkedAt}`
        ].join("\n"),
        "Funding Status"
      );

      if (Number(amount) > 0) {
        const proceed = requiredBoolean(await p.confirm({
          message: "Continue with the current balance?",
          initialValue: true
        }), "funding continue confirmation");

        if (proceed) return lastProbe;
      } else {
        const waitMore = requiredBoolean(await p.confirm({
          message: "Balance is still zero. Check again after depositing?",
          initialValue: true
        }), "funding wait confirmation");

        if (!waitMore) return lastProbe;
      }
    } catch (error) {
      await p.note(
        `Failed to read USDC balance: ${(error as Error).message}`,
        "Funding Error"
      );

      const retry = requiredBoolean(await p.confirm({
        message: "Try the balance check again?",
        initialValue: false
      }), "funding retry confirmation");

      if (!retry) return lastProbe;
    }
  }
}

async function promptModelSelection(
  settings: VaultManagerSettings,
  existing?: string
): Promise<{ modelPreference?: string; inheritedModelSnapshot?: string; inheritedModelSnapshotAt?: string }> {
  const choice = requiredString(
    await p.select({
      message: "Model selection for the vault-manager agent",
      initialValue: existing ? "override" : "inherit",
      options: [
        {
          value: "inherit",
          label: "Use the default OpenClaw model routing",
          hint: "Recommended unless you already know which model to use."
        },
        {
          value: "override",
          label: "Pin a specific model for this agent",
          hint: "Examples: anthropic/claude-sonnet-4-6, codex/gpt-5, codex/o4-mini."
        }
      ]
    }),
    "model selection"
  );

  if (choice === "inherit") {
    const snapshot = await getDefaultModel(settings);
    return {
      modelPreference: undefined,
      inheritedModelSnapshot: snapshot,
      inheritedModelSnapshotAt: snapshot ? new Date().toISOString() : undefined
    };
  }

  const value = optionalString(
    await p.text({
      message: "Model identifier",
      placeholder: existing ?? "anthropic/claude-sonnet-4-6",
      defaultValue: existing ?? ""
    })
  );

  const modelPreference = value.length > 0 ? value : undefined;
  return { modelPreference };
}

function parseNumericInput(raw: string, label: string, opts: { min: number; max: number }): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    fail(`${label} must be a number.`);
  }
  if (value < opts.min || value > opts.max) {
    fail(`${label} must be between ${opts.min} and ${opts.max}.`);
  }
  return value;
}

async function promptRiskPresetOverrides(
  preset: RiskPreset,
  previous?: RiskPreset
): Promise<void> {
  if (previous) {
    preset.rebalanceDriftPct = previous.rebalanceDriftPct;
    preset.minimumTotalManagedUsd = previous.minimumTotalManagedUsd;
  }

  const customize = requiredBoolean(
    await p.confirm({
      message: "Customize rebalance thresholds? (drift % and minimum managed USDC)",
      initialValue: false
    }),
    "customize thresholds confirmation"
  );
  if (!customize) return;

  const driftPctInput = requiredString(
    await p.text({
      message: "Drift threshold (% deviation from target before rebalancing)",
      placeholder: (preset.rebalanceDriftPct * 100).toFixed(2),
      defaultValue: (preset.rebalanceDriftPct * 100).toFixed(2)
    }),
    "drift threshold"
  );
  const driftPct = parseNumericInput(driftPctInput, "drift threshold", { min: 0.1, max: 50 });
  preset.rebalanceDriftPct = driftPct / 100;

  const minTotalInput = requiredString(
    await p.text({
      message: "Minimum total managed USDC before rebalancing runs (dust floor)",
      placeholder: String(preset.minimumTotalManagedUsd),
      defaultValue: String(preset.minimumTotalManagedUsd)
    }),
    "minimum total managed USD"
  );
  preset.minimumTotalManagedUsd = parseNumericInput(minTotalInput, "minimum total managed USD", {
    min: 0,
    max: 1_000_000
  });
}

async function promptCronSchedule(
  settings: VaultManagerSettings,
  existingExpression?: string,
  defaultCron?: string
): Promise<string> {
  const initialValue = cronScheduleSelectionForExpression(existingExpression ?? defaultCron ?? settings.defaultCron);
  const selection = requiredString(
    await p.select({
      message: "Cron schedule",
      initialValue,
      options: [
        ...Object.values(CRON_SCHEDULE_PRESETS).map((preset) => ({
          value: preset.id,
          label: preset.label,
          hint: `${preset.description} ${preset.cronExpression}`
        })),
        {
          value: "custom",
          label: "Custom cron expression",
          hint: "Enter an advanced cron expression manually."
        }
      ]
    }),
    "cron schedule"
  ) as CronScheduleSelection;

  if (selection !== "custom") {
    return CRON_SCHEDULE_PRESETS[selection].cronExpression;
  }

  return requiredString(
    await p.text({
      message: "Custom cron expression",
      placeholder: defaultCron ?? settings.defaultCron,
      defaultValue: existingExpression ?? defaultCron ?? ""
    }),
    "cron expression"
  );
}


async function preResolveWalletAdoption(
  settings: VaultManagerSettings,
  profileId: string
): Promise<{ walletRef: string; passphrase: string } | undefined> {
  const status = await inspectWalletStatus(settings, profileId);

  if (status.kind === "marker-corrupt") {
    const clear = requiredBoolean(
      await p.confirm({
        message: `Plugin wallet marker at ${status.markerPath} is unreadable (${status.error}). Delete it and re-detect the wallet?`,
        initialValue: false
      }),
      "marker clear confirmation"
    );
    if (!clear) {
      fail(
        `Fix or remove ${status.markerPath} before rerunning configure. If the original wallet is still in OWS, re-run with --wallet <name>.`
      );
    }
    await deleteWalletMarker(settings, profileId);
    return preResolveWalletAdoption(settings, profileId);
  }

  if (status.kind === "marker-stale") {
    await p.note(
      [
        `Plugin wallet marker points at wallet '${status.marker.walletRef}' but OWS no longer lists it.`,
        "",
        "Options:",
        `  - Re-run with --wallet <existing-name-or-id> to point at a different wallet.`,
        `  - Delete the stale marker (this does NOT delete any OWS wallet) and let configure auto-detect or create.`
      ].join("\n"),
      "Stale Wallet Marker"
    );
    const clear = requiredBoolean(
      await p.confirm({
        message: `Delete stale marker at ${walletMarkerPath(settings, profileId)} and continue?`,
        initialValue: false
      }),
      "stale marker clear confirmation"
    );
    if (!clear) {
      fail(`Resolve the stale wallet marker before rerunning configure.`);
    }
    await deleteWalletMarker(settings, profileId);
    return preResolveWalletAdoption(settings, profileId);
  }

  if (status.kind === "no-marker-canonical-exists") {
    const adopt = requiredBoolean(
      await p.confirm({
        message: `Found existing OWS wallet '${status.entry.name}' (${status.entry.evmAddress}). Adopt it for profile '${profileId}'?`,
        initialValue: true
      }),
      "adopt existing wallet confirmation"
    );
    if (!adopt) return undefined;

    const entered = await p.password({
      message: `Passphrase for wallet ${status.entry.name}`
    });
    if (p.isCancel(entered) || !entered) {
      fail("Passphrase is required to adopt the existing wallet.");
    }
    return { walletRef: status.entry.name, passphrase: entered as string };
  }

  return undefined;
}

async function resolveOverrideParams(
  context: ConfigureContext
): Promise<{ walletRef: string; passphrase: string } | undefined> {
  const walletRef =
    context.walletOverrideRef ??
    (process.env.OWS_VAULT_MANAGER_WALLET || undefined);
  if (!walletRef) return undefined;

  let passphrase: string | undefined;
  if (context.walletPassphraseEnvVar) {
    passphrase = process.env[context.walletPassphraseEnvVar];
    if (!passphrase) {
      fail(
        `--wallet-passphrase-env points at ${context.walletPassphraseEnvVar} but that env var is not set.`
      );
    }
  } else if (process.env.OWS_VAULT_MANAGER_WALLET_PASSPHRASE) {
    passphrase = process.env.OWS_VAULT_MANAGER_WALLET_PASSPHRASE;
  } else {
    const entered = await p.password({
      message: `Passphrase for wallet ${walletRef}`
    });
    if (p.isCancel(entered) || !entered) {
      fail("Wallet passphrase is required when --wallet is supplied.");
    }
    passphrase = entered as string;
  }

  return { walletRef, passphrase: passphrase! };
}

export async function runConfigureFlow(context: ConfigureContext): Promise<ConfigureResult> {
  const { settings, profileId } = context;
  const existing = await loadProfile(settings, profileId);

  p.intro(`Morpho Vault Manager configure (${profileId})`);

  await preflight(settings);

  let override = await resolveOverrideParams(context);
  if (!override) {
    override = await preResolveWalletAdoption(settings, profileId);
  }
  const resolution = await resolveOrCreateWallet(settings, {
    profileId,
    override
  });
  const wallet = {
    walletMode:
      resolution.source === "override" ||
      (resolution.source === "marker" && resolution.markerSource === "operator-provided")
        ? "existing"
        : "created",
    walletRef: resolution.walletRef,
    walletAddress: resolution.walletAddress
  } as const;
  await p.note(
    `Wallet ready: ${resolution.canonicalName} (${resolution.walletAddress}) [${resolution.source}]`,
    "Wallet"
  );

  if (resolution.nameCollided) {
    await p.note(
      `An OWS wallet named '${canonicalWalletName(profileId)}' already exists but plugin state is missing. Created '${resolution.canonicalName}' instead. To reuse the original wallet, rerun with:\n  openclaw vault-manager configure --profile ${profileId} --wallet ${canonicalWalletName(profileId)}`,
      "Wallet Name Collision"
    );
  }

  const tokenEnvVar = tokenEnvVarForProfile(settings, profileId);
  const tokenSource: TokenSource = { kind: "env", envVar: tokenEnvVar };

  const agentId = agentIdForProfile(settings, profileId);
  const workspaceDir = workspaceDirForAgent(settings, agentId);

  const provisionSpinner = p.spinner();
  provisionSpinner.start("Verifying wallet passphrase & provisioning OWS API key...");
  const maxPassphraseRetries = 3;
  let apiKeyAttempts = 0;
  let apiResult: { token: string } | undefined;
  let resolutionPassphrase = resolution.passphrase;
  while (!apiResult) {
    try {
      apiResult = await provisionApiKey({
        settings,
        walletRef: resolution.walletRef,
        keyName: `${agentId}-agent`,
        passphrase: resolutionPassphrase
      });
    } catch (error) {
      const isBadPassphrase = (error as { code?: string }).code === "bad_passphrase";
      if (
        isBadPassphrase &&
        resolution.source === "override" &&
        apiKeyAttempts < maxPassphraseRetries
      ) {
        apiKeyAttempts += 1;
        provisionSpinner.stop(
          `Passphrase rejected by OWS (attempt ${apiKeyAttempts}/${maxPassphraseRetries + 1}).`
        );
        const entered = await p.password({
          message: `Retry passphrase for wallet ${resolution.walletRef}`
        });
        if (p.isCancel(entered) || !entered) {
          fail("Wallet passphrase retry cancelled.");
        }
        resolutionPassphrase = entered as string;
        provisionSpinner.start("Verifying wallet passphrase & provisioning OWS API key...");
        continue;
      }
      provisionSpinner.stop("OWS API key provisioning failed.");
      if (isBadPassphrase) {
        fail(
          resolution.source === "override"
            ? `Passphrase rejected by OWS after ${apiKeyAttempts + 1} attempts. Rerun configure once you have the correct passphrase.`
            : `Stored passphrase for wallet '${resolution.walletRef}' is no longer accepted by OWS. Fix ${walletMarkerPath(settings, profileId)} or rerun configure with --wallet <ref>.`
        );
      }
      fail(`OWS API key provisioning failed: ${(error as Error).message}`);
    }
  }
  provisionSpinner.stop("Wallet passphrase verified; OWS API key provisioned.");

  if (resolution.source === "override") {
    await writeWalletMarker(settings, profileId, {
      walletRef: resolution.walletRef,
      walletAddress: resolution.walletAddress,
      passphrase: resolutionPassphrase,
      source: "operator-provided",
      canonicalName: resolution.canonicalName,
      createdAt: new Date().toISOString()
    });
  }

  await writeTokenToOpenclawEnv(settings, tokenEnvVar, apiResult.token);

  await p.note(
    `Token written to openclaw.json env.vars.${tokenEnvVar} (rotated on every configure run).`,
    "Token Wired"
  );

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

  const riskPreset: RiskPreset = structuredClone(RISK_PRESETS[riskProfile]);
  const previousCustomizations =
    existing.profile?.riskProfile === riskProfile ? existing.profile.riskPreset : undefined;
  await promptRiskPresetOverrides(riskPreset, previousCustomizations);

  await p.note(
    [
      `Selected risk profile: ${riskPreset.label}`,
      "Machine-readable risk config:",
      formatRiskPresetConfig(riskPreset)
    ].join("\n"),
    "Risk Config"
  );

  const modelSelection = await promptModelSelection(settings, existing.profile?.modelPreference);
  const { modelPreference, inheritedModelSnapshot, inheritedModelSnapshotAt } = modelSelection;
  const delivery = await promptCronDelivery(settings, existing.profile ?? undefined);

  const cronExpression = await promptCronSchedule(settings, existing.profile?.cronExpression, settings.defaultCron);

  const timezone = requiredString(
    await p.text({
      message: "Cron timezone",
      placeholder: settings.defaultTimezone,
      defaultValue: existing.profile?.timezone ?? settings.defaultTimezone
    }),
    "cron timezone"
  );

  await p.note(
    [
      `Schedule: ${describeCronSchedule(cronExpression)}`,
      `Timezone: ${timezone}`,
      `Delivery: ${describeDeliveryTarget(delivery)}`,
      `Machine-readable cron expression: ${cronExpression}`
    ].join("\n"),
    "Cron Schedule"
  );

  const cronEnabled = requiredBoolean(await p.confirm({
    message: "Enable the cron job immediately?",
    initialValue: existing.profile?.cronEnabled ?? false
  }), "cron enable confirmation");

  const fundingProbe = await promptFundingGuidance(settings, wallet.walletAddress);

  await ensureDir(workspaceDir);

  const profile: VaultManagerProfile = {
    profileId,
    chain: "base",
    walletRef: wallet.walletRef,
    walletAddress: wallet.walletAddress,
    walletMode: wallet.walletMode,
    riskProfile,
    tokenEnvVar,
    tokenSource,
    usdcAddress: BASE_USDC_ADDRESS,
    agentId,
    workspaceDir,
    cronJobId: existing.profile?.cronJobId,
    cronJobName: existing.profile?.cronJobName ?? `${settings.baseCronName} (${profileId})`,
    cronExpression,
    timezone,
    notifications: delivery.notifications,
    deliveryChannel: delivery.deliveryChannel,
    deliveryTo: delivery.deliveryTo,
    deliveryAccountId: delivery.deliveryAccountId,
    cronEnabled,
    createdAt: existing.profile?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    riskPreset,
    modelPreference,
    inheritedModelSnapshot,
    inheritedModelSnapshotAt,

    lastFundedCheckAt: fundingProbe?.checkedAt ?? existing.profile?.lastFundedCheckAt,
    lastFundedUsdc: fundingProbe?.balance ?? existing.profile?.lastFundedUsdc,
    lastValidationRun: existing.profile?.lastValidationRun
  };

  const agentResult = await ensureAgent({
    settings,
    agentId,
    workspaceDir,
    modelPreference
  });

  if (!agentResult.ok) {
    fail(`Failed to create or resolve OpenClaw agent ${agentId}.\n${agentResult.stderr || agentResult.stdout}`);
  }

  const agentsMdPath = path.join(workspaceDir, "AGENTS.md");
  const agentsMd = await readTextFile(agentsMdPath);
  const vaultManagerInstructions = renderAgentInstructions(profile);
  if (agentsMd === null) {
    await writeTextFile(agentsMdPath, vaultManagerInstructions);
  } else {
    await writeTextFile(
      agentsMdPath,
      agentsMd.trimEnd() + "\n\n" + vaultManagerInstructions
    );
  }

  const skillResult = await installSkill({
    workspaceDir,
    slug: "morpho-cli",
    force: true
  });

  if (!skillResult.ok) {
    await p.note(
      [
        "Failed to install the morpho-cli skill into the agent workspace.",
        "",
        "Install it manually:",
        `  clawhub --workdir "${workspaceDir}" install morpho-cli`,
        "",
        "stderr:",
        skillResult.stderr || "(empty)"
      ].join("\n"),
      "Morpho Skill"
    );
  }

  const cronResult = await upsertCronJob({
    settings,
    profile
  });

  if (!cronResult.ok || !cronResult.jobId) {
    fail(`Failed to create or update the cron job.\n${cronResult.stderr || cronResult.stdout}`);
  }

  profile.cronJobId = cronResult.jobId;

  let profilePath = await saveProfile(settings, profile);

  await p.note(
    [
      `Profile: ${profilePath}`,
      `Workspace: ${workspaceDir}`,
      `Agent: ${agentId}`,
      `Cron job: ${profile.cronJobId}`,
      `Wallet mode: ${profile.walletMode}`,
      `Schedule: ${describeCronSchedule(profile.cronExpression)}`,
      `Delivery: ${describeDeliveryTarget(profile)}`,
      `Risk config: ${formatRiskPresetConfig(profile.riskPreset)}`,
      `Token source: env:${tokenEnvVar}`,
      `Model: ${modelPreference ?? (inheritedModelSnapshot ? `(default OpenClaw routing, currently ${inheritedModelSnapshot})` : "(default OpenClaw routing)")}`
    ].join("\n"),
    "Configured"
  );

  const runValidation = requiredBoolean(await p.confirm({
    message: "Run a validation dry-run to verify the rebalance plan?",
    initialValue: true
  }), "validation run confirmation");

  if (runValidation) {
    const spinner = p.spinner();
    spinner.start("Computing validation plan...");
    try {
      const planResult = await runPlan(settings, profileId);
      spinner.stop("Validation plan computed.");

      const lines = [
        `Status: ${planResult.status}`,
        `Drift: ${planResult.metrics.maxDriftPct}% (threshold: ${planResult.metrics.driftThresholdPct}%)`,
        `Managed USDC: ${planResult.metrics.totalManagedUsdc}`,
        `Idle USDC: ${planResult.metrics.idleUsdc}`,
        `Actions: ${planResult.actions.length}`,
        `Receipt: ${planResult.receiptPath}`
      ];

      if (planResult.reasons.length > 0) {
        lines.push("", "Reasons:");
        for (const reason of planResult.reasons) lines.push(`  - ${reason}`);
      }
      if (planResult.warnings.length > 0) {
        lines.push("", "Warnings:");
        for (const warning of planResult.warnings) lines.push(`  - ${warning}`);
      }
      if (planResult.actions.length > 0) {
        lines.push("", "Planned actions:");
        for (const action of planResult.actions) {
          lines.push(`  - ${action.kind} ${action.amountUsdc} USDC → ${action.vaultName}`);
        }
      }

      await p.note(lines.join("\n"), "Validation Dry-Run");

      profile.lastValidationRun = {
        runId: planResult.runId,
        status: planResult.status,
        receiptPath: planResult.receiptPath,
        createdAt: planResult.createdAt
      };
      profilePath = await saveProfile(settings, profile);
    } catch (error) {
      spinner.stop("Validation plan failed.");
      await p.note(
        `Dry-run failed: ${error instanceof Error ? error.message : String(error)}\nThis does not affect your configuration — you can retry with:\n  openclaw vault-manager plan --profile ${profileId}`,
        "Validation Error"
      );
    }
  }

  await p.note(
    [
      "Your vault manager profile is ready.",
      "",
      "To perform the initial allocation of your funds into Morpho vaults, run:",
      "",
      `  openclaw vault-manager allocate --profile ${profileId}`,
      "",
      "This will invoke the agent to compute a plan and execute the allocation",
      "using morpho-cli and OWS."
    ].join("\n"),
    "Next Step"
  );

  p.outro("Vault manager configuration complete.");

  return {
    profile,
    profilePath,
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

  const effectiveSource =
    profile.tokenSource ?? settings.defaultTokenSource ?? { kind: "env", envVar: profile.tokenEnvVar };
  const tokenProbe = await resolveApiToken(effectiveSource);

  const summary = {
    profileId: profile.profileId,
    walletRef: profile.walletRef,
    walletAddress: profile.walletAddress,
    walletMode: profile.walletMode,
    riskProfile: profile.riskProfile,
    riskPreset: profile.riskPreset,
    tokenEnvVar: profile.tokenEnvVar,
    tokenSource: describeTokenSource(effectiveSource),
    tokenReady: tokenProbe.ok,
    tokenReadyError: tokenProbe.ok ? null : tokenProbe.error,
    agentId: profile.agentId,
    modelPreference: profile.modelPreference ?? null,
    inheritedModelSnapshot: profile.inheritedModelSnapshot ?? null,
    inheritedModelSnapshotAt: profile.inheritedModelSnapshotAt ?? null,
    workspaceDir: profile.workspaceDir,
    cronJobId: profile.cronJobId,
    cronExpression: profile.cronExpression,
    timezone: profile.timezone,
    cronKnownToGateway: Boolean(cronJob),
    cronEnabled: profile.cronEnabled,
    notifications: profile.notifications,
    deliveryChannel:
      profile.notifications === "announce"
        ? profile.deliveryChannel ?? settings.defaultDeliveryChannel ?? "last"
        : null,
    deliveryTo:
      profile.notifications === "announce"
        ? profile.deliveryTo ?? settings.defaultDeliveryTo ?? null
        : null,
    deliveryAccountId:
      profile.notifications === "announce"
        ? profile.deliveryAccountId ?? settings.defaultDeliveryAccountId ?? null
        : null,
    lastFundedCheckAt: profile.lastFundedCheckAt ?? null,
    lastFundedUsdc: profile.lastFundedUsdc ?? null,
    lastValidationRun: profile.lastValidationRun ?? null,
    updatedAt: profile.updatedAt
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  await p.note(
    [
      `Wallet: ${summary.walletRef} (${summary.walletAddress})`,
      `Wallet mode: ${summary.walletMode}`,
      `Risk profile: ${summary.riskProfile}`,
      `Schedule: ${describeCronSchedule(summary.cronExpression)} (${summary.timezone})`,
      `Risk config: ${formatRiskPresetConfig(summary.riskPreset)}`,
      `Token source: ${summary.tokenSource} (${summary.tokenReady ? "ready" : `unavailable: ${summary.tokenReadyError}`})`,
      `Agent: ${summary.agentId}`,
      `Model: ${summary.modelPreference ?? (summary.inheritedModelSnapshot ? `(default routing, was ${summary.inheritedModelSnapshot} at ${summary.inheritedModelSnapshotAt})` : "(default routing)")}`,
      `Workspace: ${summary.workspaceDir}`,
      `Cron job: ${summary.cronJobId ?? "missing"} (${summary.cronKnownToGateway ? "known" : "not found"})`,
      `Cron enabled: ${summary.cronEnabled ? "yes" : "no"}`,
      `Delivery: ${describeDeliveryTarget({
        notifications: profile.notifications,
        deliveryChannel: summary.deliveryChannel ?? undefined,
        deliveryTo: summary.deliveryTo ?? undefined,
        deliveryAccountId: summary.deliveryAccountId ?? undefined
      })}`,
      `Last funded check: ${summary.lastFundedCheckAt ?? "never"}${
        summary.lastFundedUsdc ? ` (${summary.lastFundedUsdc} USDC)` : ""
      }`,
      `Last validation run: ${
        summary.lastValidationRun
          ? `${summary.lastValidationRun.status} @ ${summary.lastValidationRun.createdAt}`
          : "never"
      }`
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

export async function allocateProfile(settings: VaultManagerSettings, profileId: string): Promise<void> {
  const loaded = await loadProfile(settings, profileId);
  const profile = loaded.profile;
  if (!profile || !profile.cronJobId) {
    fail(`Profile ${profileId} does not have a cron job. Run "openclaw vault-manager configure" first.`);
  }

  const output = await runCronJobNow(settings, profile.cronJobId);
  await p.note(
    output || "Agent run enqueued. The agent will compute a plan and execute the allocation using morpho-cli and OWS.",
    `Allocate: ${profileId}`
  );
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

function renderPlanSummary(result: PlanResult): string {
  const lines = [
    `Status: ${result.status}`,
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

  return lines.join("\n");
}

async function presentPlanResult(result: PlanResult, json: boolean, title: string): Promise<void> {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  await p.note(renderPlanSummary(result), title);
}

export async function runProfilePlan(
  settings: VaultManagerSettings,
  profileId: string,
  json: boolean
): Promise<void> {
  const result = await runPlan(settings, profileId);
  await presentPlanResult(result, json, `Plan: ${profileId}`);
}
