import type { Command } from "commander";
import {
  allocateProfile,
  pauseProfile,
  resumeProfile,
  runConfigureFlow,
  runProfileNow,
  runProfilePlan,
  showStatus
} from "./configure.js";
import { runHistory } from "./history.js";
import { runShow } from "./show.js";
import { runTeardown, runTeardownAll } from "./teardown.js";
import type { PlanStatus } from "../lib/rebalance.js";
import type { CliLogger, VaultManagerSettings } from "../lib/types.js";

type RegisterContext = {
  program: Command;
  logger?: CliLogger;
  settings: VaultManagerSettings;
};

export function registerVaultManagerCli({ program, logger, settings }: RegisterContext): void {
  const vaultManager = program.command("vault-manager").description("Configure and operate the Morpho vault manager agent");

  vaultManager
    .command("configure")
    .description("Run the guided onboarding flow for a vault manager profile")
    .option("--profile <id>", "Profile id", "default")
    .option("--wallet <ref>", "Use this existing OWS wallet (name or UUID) instead of auto-creating")
    .option(
      "--wallet-passphrase-env <var>",
      "Env var name that holds the passphrase for --wallet (overrides the interactive prompt)"
    )
    .action(async (opts: { profile: string; wallet?: string; walletPassphraseEnv?: string }) => {
      logger?.info?.(`vault-manager: configure ${opts.profile}`);
      await runConfigureFlow({
        settings,
        logger,
        profileId: opts.profile,
        walletOverrideRef: opts.wallet,
        walletPassphraseEnvVar: opts.walletPassphraseEnv
      });
    });

  vaultManager
    .command("reconfigure")
    .description("Re-run configure for an existing profile")
    .option("--profile <id>", "Profile id", "default")
    .option("--wallet <ref>", "Use this existing OWS wallet (name or UUID) instead of auto-creating")
    .option(
      "--wallet-passphrase-env <var>",
      "Env var name that holds the passphrase for --wallet (overrides the interactive prompt)"
    )
    .action(async (opts: { profile: string; wallet?: string; walletPassphraseEnv?: string }) => {
      logger?.info?.(`vault-manager: reconfigure ${opts.profile}`);
      await runConfigureFlow({
        settings,
        logger,
        profileId: opts.profile,
        walletOverrideRef: opts.wallet,
        walletPassphraseEnvVar: opts.walletPassphraseEnv
      });
    });

  vaultManager
    .command("status")
    .description("Show profile, workspace, and cron status")
    .option("--profile <id>", "Profile id", "default")
    .option("--json", "Output JSON", false)
    .action(async (opts: { profile: string; json: boolean }) => {
      await showStatus(settings, opts.profile, opts.json);
    });

  vaultManager
    .command("show")
    .description("Visualize current vault exposure and underlying market allocations via Morpho GraphQL")
    .option("--profile <id>", "Profile id (wallet address is read from this profile)", "default")
    .option("--address <hex>", "Override the wallet address to inspect (bypasses the profile)")
    .option("--chain-id <n>", "EVM chain id (default 8453 Base)", (value) => Number.parseInt(value, 10))
    .option("--endpoint <url>", "Override Morpho GraphQL endpoint")
    .option("--json", "Emit the raw GraphQL-derived payload as JSON", false)
    .option("--no-color", "Disable ANSI color output", false)
    .action(
      async (opts: {
        profile: string;
        address?: string;
        chainId?: number;
        endpoint?: string;
        json: boolean;
        color: boolean;
      }) => {
        await runShow(settings, {
          profile: opts.profile,
          address: opts.address,
          chainId: opts.chainId,
          endpoint: opts.endpoint,
          json: opts.json,
          noColor: opts.color === false
        });
      }
    );

  vaultManager
    .command("allocate")
    .description("Invoke the agent to allocate funds into Morpho vaults")
    .option("--profile <id>", "Profile id", "default")
    .action(async (opts: { profile: string }) => {
      await allocateProfile(settings, opts.profile);
    });

  vaultManager
    .command("run-now")
    .description("Queue an immediate cron run for the profile")
    .option("--profile <id>", "Profile id", "default")
    .action(async (opts: { profile: string }) => {
      await runProfileNow(settings, opts.profile);
    });

  vaultManager
    .command("plan")
    .description("Compute a deterministic rebalance plan (scoring, allocation, actions)")
    .option("--profile <id>", "Profile id", "default")
    .option("--json", "Output JSON", false)
    .action(async (opts: { profile: string; json: boolean }) => {
      await runProfilePlan(settings, opts.profile, opts.json);
    });

  vaultManager
    .command("pause")
    .description("Disable the profile cron job")
    .option("--profile <id>", "Profile id", "default")
    .action(async (opts: { profile: string }) => {
      await pauseProfile(settings, opts.profile);
    });

  vaultManager
    .command("resume")
    .description("Enable the profile cron job")
    .option("--profile <id>", "Profile id", "default")
    .action(async (opts: { profile: string }) => {
      await resumeProfile(settings, opts.profile);
    });

  vaultManager
    .command("teardown")
    .description("Remove all resources created by configure for a profile")
    .option("--profile <id>", "Profile id", "default")
    .option("--all", "Tear down all profiles", false)
    .option("--force", "Skip confirmation prompt", false)
    .option("--keep-logs", "Preserve run logs and receipts", false)
    .action(async (opts: { profile: string; all: boolean; force: boolean; keepLogs: boolean }) => {
      logger?.info?.(`vault-manager: teardown ${opts.all ? "(all)" : opts.profile}`);
      if (opts.all) {
        await runTeardownAll(settings, opts.force, opts.keepLogs);
      } else {
        await runTeardown({ settings, profileId: opts.profile, force: opts.force, keepLogs: opts.keepLogs });
      }
    });

  vaultManager
    .command("history")
    .description("Show past rebalance runs with enriched metrics")
    .option("--profile <id>", "Profile id", "default")
    .option("--json", "Output JSON", false)
    .option("--run <runId>", "Show a specific run (runId or unique prefix)")
    .option("--logs <runId>", "Stream the JSONL log for a run")
    .option("--since <iso>", "Filter runs with createdAt >= this ISO date")
    .option("--status <status>", "Filter by status: planned | no_op | blocked")
    .option("--limit <n>", "Max runs to include (default 20)", "20")
    .action(async (opts: {
      profile: string;
      json: boolean;
      run?: string;
      logs?: string;
      since?: string;
      status?: string;
      limit: string;
    }) => {
      await runHistory(settings, {
        profileId: opts.profile,
        json: !!opts.json,
        run: opts.run,
        logs: opts.logs,
        since: opts.since,
        status: opts.status as PlanStatus | undefined,
        limit: Number.parseInt(opts.limit, 10)
      });
    });
}
