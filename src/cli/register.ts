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
import { runTeardown, runTeardownAll } from "./teardown.js";
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
}
