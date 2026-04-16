import path from "node:path";
import * as p from "@clack/prompts";
import { getAddress, isAddress } from "viem";
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
  installSkill,
  listConfiguredTelegramAccounts,
  listCronJobs,
  listTelegramGroups,
  runCronJobNow,
  upsertCronJob
} from "../lib/openclaw.js";
import { runPreflightChecks } from "../lib/preflight.js";
import { commandExists } from "../lib/shell.js";
import { runPlan, type PlanResult } from "../lib/rebalance.js";
import { buildApiKeyCreateCommand, buildWalletCreateCommand } from "../lib/ows.js";
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
        { value: "announce", label: "Announce run summaries", hint: "Post run summaries back through OpenClaw." },
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
    await p.note(
      [
        owsIssue.message,
        "",
        "OWS (Open Wallet SDK) is required for wallet creation, transaction signing, and policy management.",
        "",
        "Install with:",
        "  curl -fsSL https://docs.openwallet.sh/install.sh | bash",
        "",
        "After installing, verify with:",
        `  ${settings.owsCommand} --version`,
        "",
        "Full docs: https://docs.openwallet.sh/"
      ].join("\n"),
      "OWS Not Found"
    );

    while (true) {
      const retry = requiredBoolean(
        await p.confirm({
          message: "Have you installed OWS? Retry the check?",
          initialValue: false
        }),
        "OWS install confirmation"
      );

      if (!retry) {
        fail("Install OWS before running configure. See https://docs.openwallet.sh/");
      }

      if (await commandExists(settings.owsCommand)) {
        break;
      }

      await p.note(
        `${settings.owsCommand} is still not found in PATH.`,
        "OWS Still Missing"
      );
    }
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

async function promptWallet(settings: VaultManagerSettings, existing?: VaultManagerProfile): Promise<{
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
      [
        "Manual step 1/2: create the OWS wallet in your own shell so the plugin never handles owner credentials.",
        "",
        buildWalletCreateCommand(settings, walletName),
        "",
        "Return here after the wallet exists and paste the public address below."
      ].join("\n"),
      "Wallet Setup"
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

  await p.note(
    [
      "Manual step 1/2: point the wizard at an existing OWS wallet reference and confirm the public address.",
      "No wallet import happens inside the plugin, and no recovery material is collected here."
    ].join("\n"),
    "Wallet Setup"
  );

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

async function promptTokenSource(
  defaultSource: TokenSource,
  existing?: TokenSource
): Promise<TokenSource> {
  const baseline = existing ?? defaultSource;
  const kind = requiredString(
    await p.select({
      message: "OWS API token source",
      initialValue: baseline.kind,
      options: [
        {
          value: "env",
          label: "Environment variable",
          hint: "Gateway process reads the token from an env var. Good for ad-hoc setups."
        },
        {
          value: "file",
          label: "File on disk",
          hint: "Read the token from a file path (mounted secrets, systemd EnvironmentFile, etc)."
        }
      ]
    }),
    "token source"
  ) as TokenSource["kind"];

  if (kind === "env") {
    const envVar = requiredString(
      await p.text({
        message: "Environment variable name",
        placeholder:
          baseline.kind === "env" ? baseline.envVar : defaultSource.kind === "env" ? defaultSource.envVar : "OWS_MORPHO_VAULT_MANAGER_TOKEN",
        defaultValue: baseline.kind === "env" ? baseline.envVar : ""
      }),
      "token environment variable"
    );
    return { kind: "env", envVar };
  }

  const filePath = requiredString(
    await p.text({
      message: "Secret file path",
      placeholder:
        baseline.kind === "file" ? baseline.path : "/run/secrets/morpho-vault-manager-token",
      defaultValue: baseline.kind === "file" ? baseline.path : ""
    }),
    "secret file path"
  );

  const mode = requiredString(
    await p.select({
      message: "Secret file format",
      initialValue: baseline.kind === "file" ? baseline.mode ?? "singleValue" : "singleValue",
      options: [
        { value: "singleValue", label: "Plain text containing only the token" },
        { value: "json", label: "JSON file with a token field" }
      ]
    }),
    "secret file format"
  ) as "singleValue" | "json";

  const jsonField =
    mode === "json"
      ? optionalString(
          await p.text({
            message: "JSON field name",
            placeholder: baseline.kind === "file" ? baseline.jsonField ?? "apiKey" : "apiKey",
            defaultValue: baseline.kind === "file" ? baseline.jsonField ?? "" : ""
          })
        )
      : "";

  return {
    kind: "file",
    path: filePath,
    mode,
    jsonField: jsonField.length > 0 ? jsonField : undefined
  };
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

async function promptModelSelection(existing?: string): Promise<string | undefined> {
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

  if (choice === "inherit") return undefined;

  const value = optionalString(
    await p.text({
      message: "Model identifier",
      placeholder: existing ?? "anthropic/claude-sonnet-4-6",
      defaultValue: existing ?? ""
    })
  );

  return value.length > 0 ? value : undefined;
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


export async function runConfigureFlow(context: ConfigureContext): Promise<ConfigureResult> {
  const { settings, profileId } = context;
  const existing = await loadProfile(settings, profileId);

  p.intro(`Morpho Vault Manager configure (${profileId})`);

  await preflight(settings);

  const wallet = await promptWallet(settings, existing.profile ?? undefined);

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

  const riskPreset = RISK_PRESETS[riskProfile];
  await p.note(
    [
      `Selected risk profile: ${riskPreset.label}`,
      "Machine-readable risk config:",
      formatRiskPresetConfig(riskPreset)
    ].join("\n"),
    "Risk Config"
  );

  const modelPreference = await promptModelSelection(existing.profile?.modelPreference);
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

  const defaultTokenEnvVar = tokenEnvVarForProfile(settings, profileId);
  const defaultTokenSourceForProfile: TokenSource =
    settings.defaultTokenSource.kind === "env"
      ? { kind: "env", envVar: defaultTokenEnvVar }
      : settings.defaultTokenSource;
  const tokenSource = await promptTokenSource(
    defaultTokenSourceForProfile,
    existing.profile?.tokenSource
  );
  const tokenEnvVar =
    tokenSource.kind === "env" ? tokenSource.envVar : defaultTokenEnvVar;
  const agentId = agentIdForProfile(settings, profileId);
  const workspaceDir = workspaceDirForAgent(settings, agentId);
  const cronEnabled = requiredBoolean(await p.confirm({
    message: "Enable the cron job immediately?",
    initialValue: existing.profile?.cronEnabled ?? false
  }), "cron enable confirmation");

  const tokenSourceDescription = describeTokenSource(tokenSource);
  const tokenProvisioningHint = (() => {
    if (tokenSource.kind === "env") {
      return `Inject the returned token into the OpenClaw gateway environment as ${tokenSource.envVar}.`;
    }
    if (tokenSource.kind === "file") {
      const jsonSuffix =
        tokenSource.mode === "json"
          ? ` (JSON field "${tokenSource.jsonField ?? "apiKey"}")`
          : "";
      return `Write the returned token to ${tokenSource.path}${jsonSuffix} and make sure the OpenClaw gateway process can read it.`;
    }
    return `Token is pre-resolved by the OpenClaw host (${tokenSource.origin}). No manual provisioning required.`;
  })();

  await p.note(
    [
      "Manual step 2/2: create the OWS API key yourself so the token never passes through the plugin process.",
      "",
      buildApiKeyCreateCommand({
        settings,
        keyName: `${agentId}-agent`,
        walletRef: wallet.walletRef
      }),
      "",
      tokenProvisioningHint,
      "",
      `Token source: ${tokenSourceDescription}`
    ].join("\n"),
    "OWS API Key"
  );

  while (true) {
    const probe = await resolveApiToken(tokenSource);
    if (probe.ok) {
      await p.note(`Token source ${probe.description} resolved successfully.`, "Token Verified");
      break;
    }

    const retry = requiredBoolean(
      await p.confirm({
        message: `Token not yet available (${probe.description}). ${probe.error}\nRetry after provisioning?`,
        initialValue: true
      }),
      "token retry confirmation"
    );

    if (!retry) {
      fail(
        `OWS API token could not be resolved via ${tokenSourceDescription}. Provision it and rerun configure.`
      );
    }
  }

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
      `Token source: ${tokenSourceDescription}`,
      `Model: ${modelPreference ?? "(default OpenClaw routing)"}`
    ].join("\n"),
    "Configured"
  );

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
      `Model: ${summary.modelPreference ?? "(default routing)"}`,
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
