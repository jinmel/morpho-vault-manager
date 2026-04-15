import { pauseProfile, resumeProfile, runConfigureFlow, runProfileDryRun, runProfileLive, runProfileNow, showStatus } from "./configure.js";
export function registerVaultManagerCli({ program, logger, settings }) {
    const vaultManager = program.command("vault-manager").description("Configure and operate the Morpho vault manager agent");
    vaultManager
        .command("configure")
        .description("Run the guided onboarding flow for a vault manager profile")
        .option("--profile <id>", "Profile id", "default")
        .action(async (opts) => {
        logger?.info?.(`vault-manager: configure ${opts.profile}`);
        await runConfigureFlow({
            settings,
            logger,
            profileId: opts.profile
        });
    });
    vaultManager
        .command("reconfigure")
        .description("Re-run configure for an existing profile")
        .option("--profile <id>", "Profile id", "default")
        .action(async (opts) => {
        logger?.info?.(`vault-manager: reconfigure ${opts.profile}`);
        await runConfigureFlow({
            settings,
            logger,
            profileId: opts.profile
        });
    });
    vaultManager
        .command("status")
        .description("Show profile, workspace, and cron status")
        .option("--profile <id>", "Profile id", "default")
        .option("--json", "Output JSON", false)
        .action(async (opts) => {
        await showStatus(settings, opts.profile, opts.json);
    });
    vaultManager
        .command("run-now")
        .description("Queue an immediate cron run for the profile")
        .option("--profile <id>", "Profile id", "default")
        .action(async (opts) => {
        await runProfileNow(settings, opts.profile);
    });
    vaultManager
        .command("dry-run")
        .description("Compute a deterministic rebalance plan without signing")
        .option("--profile <id>", "Profile id", "default")
        .option("--json", "Output JSON", false)
        .action(async (opts) => {
        await runProfileDryRun(settings, opts.profile, opts.json);
    });
    vaultManager
        .command("live-run")
        .description("Execute a rebalance through OWS with explicit arming")
        .option("--profile <id>", "Profile id", "default")
        .option("--json", "Output JSON", false)
        .option("--allow-live", "Arm live execution", false)
        .action(async (opts) => {
        await runProfileLive(settings, opts.profile, opts.json, opts.allowLive);
    });
    vaultManager
        .command("pause")
        .description("Disable the profile cron job")
        .option("--profile <id>", "Profile id", "default")
        .action(async (opts) => {
        await pauseProfile(settings, opts.profile);
    });
    vaultManager
        .command("resume")
        .description("Enable the profile cron job")
        .option("--profile <id>", "Profile id", "default")
        .action(async (opts) => {
        await resumeProfile(settings, opts.profile);
    });
}
