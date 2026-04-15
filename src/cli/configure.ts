import path from "node:path";
import * as p from "@clack/prompts";
import { getAddress, isAddress } from "viem";
import { BASE_USDC_ADDRESS, RISK_PRESETS } from "../lib/constants.js";
import { ensureDir, writeTextFile } from "../lib/fs.js";
import { getMorphoTokenBalance } from "../lib/morpho.js";
import { describeTokenSource, resolveApiToken, type TokenSource } from "../lib/secrets.js";
import { disableCronJob, enableCronJob, ensureAgent, listCronJobs, runCronJobNow, upsertCronJob } from "../lib/openclaw.js";
import { writePolicyArtifacts } from "../lib/policy.js";
import { runPreflightChecks } from "../lib/preflight.js";
import { runRebalance, type RebalanceRunResult } from "../lib/rebalance.js";
import { buildApiKeyCreateCommand, buildWalletCreateCommand, runOwsPolicyCreate } from "../lib/ows.js";
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
  const result = await runPreflightChecks(settings);
  const gatewayIssue = result.issues.find((issue) => issue.code === "openclaw_gateway_unreachable");
  const hardIssues = result.issues.filter((issue) => issue.code !== "openclaw_gateway_unreachable");

  if (hardIssues.length > 0) {
    fail(hardIssues.map((issue) => issue.message).join("\n"));
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

async function runValidationDryRun(
  settings: VaultManagerSettings,
  profileId: string
): Promise<RebalanceRunResult | null> {
  const wantsValidation = requiredBoolean(await p.confirm({
    message: "Run a validation dry-run now against live Morpho state?",
    initialValue: true
  }), "validation confirmation");

  if (!wantsValidation) return null;

  const spinner = p.spinner();
  spinner.start("Running dry-run rebalance");
  try {
    const result = await runRebalance(settings, profileId, "dry-run");
    spinner.stop(`Dry-run ${result.status}`);
    await p.note(
      [
        `Status:  ${result.status}`,
        `Wallet:  ${result.walletAddress}`,
        `Managed USDC: ${result.metrics.totalManagedUsdc}`,
        `Idle USDC:    ${result.metrics.idleUsdc}`,
        `Planned turnover: ${result.metrics.totalPlannedTurnoverUsdc}`,
        `Receipt: ${result.receiptPath}`,
        ...(result.reasons.length > 0 ? ["", "Reasons:", ...result.reasons.map((reason) => `- ${reason}`)] : []),
        ...(result.actions.length > 0
          ? [
              "",
              "Planned actions:",
              ...result.actions.map(
                (action) => `- ${action.kind} ${action.amountUsdc} USDC via ${action.vaultName}`
              )
            ]
          : [])
      ].join("\n"),
      "Validation Dry Run"
    );
    return result;
  } catch (error) {
    spinner.stop("Dry-run failed");
    await p.note(
      `Validation dry-run failed: ${(error as Error).message}`,
      "Validation Error"
    );
    return null;
  }
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

  const modelPreference = await promptModelSelection(existing.profile?.modelPreference);

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
        walletRef: wallet.walletRef,
        policyId: policyArtifacts.policyId
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
    allowedVaults,
    allowedSpenders,
    tokenEnvVar,
    tokenSource,
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
    riskPreset,
    modelPreference,
    armedForLiveExecution: existing.profile?.armedForLiveExecution ?? false,
    lastFundedCheckAt: fundingProbe?.checkedAt ?? existing.profile?.lastFundedCheckAt,
    lastFundedUsdc: fundingProbe?.balance ?? existing.profile?.lastFundedUsdc,
    lastValidationRun: existing.profile?.lastValidationRun
  };

  await writeTextFile(path.join(workspaceDir, "AGENTS.md"), renderAgentInstructions(profile));

  const agentResult = await ensureAgent({
    settings,
    agentId,
    workspaceDir,
    modelPreference
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

  let profilePath = await saveProfile(settings, profile);

  await p.note(
    [
      `Profile: ${profilePath}`,
      `Workspace: ${workspaceDir}`,
      `Agent: ${agentId}`,
      `Cron job: ${profile.cronJobId}`,
      `Wallet mode: ${profile.walletMode}`,
      `Schedule: ${describeCronSchedule(profile.cronExpression)}`,
      `Risk config: ${formatRiskPresetConfig(profile.riskPreset)}`,
      `Token source: ${tokenSourceDescription}`,
      `Model: ${modelPreference ?? "(default OpenClaw routing)"}`
    ].join("\n"),
    "Configured"
  );

  const validationResult = await runValidationDryRun(settings, profileId);
  if (validationResult) {
    profile.lastValidationRun = {
      runId: validationResult.runId,
      status: validationResult.status,
      receiptPath: validationResult.receiptPath,
      createdAt: validationResult.createdAt
    };
    profile.updatedAt = new Date().toISOString();
    profilePath = await saveProfile(settings, profile);
  }

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
    allowedVaults: profile.allowedVaults,
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
    policyId: profile.policyId,
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
      `Allowed vaults: ${summary.allowedVaults.length}`,
      `Token source: ${summary.tokenSource} (${summary.tokenReady ? "ready" : `unavailable: ${summary.tokenReadyError}`})`,
      `Agent: ${summary.agentId}`,
      `Model: ${summary.modelPreference ?? "(default routing)"}`,
      `Workspace: ${summary.workspaceDir}`,
      `Cron job: ${summary.cronJobId ?? "missing"} (${summary.cronKnownToGateway ? "known" : "not found"})`,
      `Cron enabled: ${summary.cronEnabled ? "yes" : "no"}`,
      `Policy: ${summary.policyId}`,
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
