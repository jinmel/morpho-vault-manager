import path from "node:path";
import * as p from "@clack/prompts";
import { pathExists, removeDir } from "../lib/fs.js";
import { deleteAgent, deleteCronJob } from "../lib/openclaw.js";
import { deleteProfileFile, listProfileIds, loadProfile } from "../lib/profile.js";
import type { VaultManagerSettings } from "../lib/types.js";
import { agentIdForProfile, workspaceDirForAgent } from "./configure.js";

type TeardownResult = {
  profileId: string;
  cronDeleted: boolean;
  agentDeleted: boolean;
  workspaceRemoved: boolean;
  logsRemoved: boolean;
  runsRemoved: boolean;
  profileRemoved: boolean;
  errors: string[];
};

type TeardownOptions = {
  settings: VaultManagerSettings;
  profileId: string;
  force?: boolean;
  keepLogs?: boolean;
};

export async function runTeardown(opts: TeardownOptions): Promise<TeardownResult> {
  const { settings, profileId, force, keepLogs } = opts;

  const result: TeardownResult = {
    profileId,
    cronDeleted: false,
    agentDeleted: false,
    workspaceRemoved: false,
    logsRemoved: false,
    runsRemoved: false,
    profileRemoved: false,
    errors: []
  };

  const { profile } = await loadProfile(settings, profileId);
  const agentId = profile?.agentId ?? agentIdForProfile(settings, profileId);
  const workspaceDir = profile?.workspaceDir ?? workspaceDirForAgent(settings, agentId);
  const cronJobId = profile?.cronJobId;
  const logsDir = path.join(settings.dataRoot, "logs", profileId);
  const runsDir = path.join(settings.dataRoot, "runs", profileId);

  const items: string[] = [];
  if (cronJobId) items.push(`Cron job: ${cronJobId}`);
  items.push(`Agent: ${agentId}`);
  items.push(`Workspace: ${workspaceDir} (${await pathExists(workspaceDir) ? "exists" : "not found"})`);
  if (!keepLogs) {
    items.push(`Logs: ${logsDir} (${await pathExists(logsDir) ? "exists" : "not found"})`);
    items.push(`Runs: ${runsDir} (${await pathExists(runsDir) ? "exists" : "not found"})`);
  }
  items.push(`Profile: ${profileId}.json`);

  if (!force) {
    await p.note(items.join("\n"), `Teardown: ${profileId}`);
    const confirmed = await p.confirm({
      message: "This will permanently remove the above resources. Continue?"
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Teardown cancelled.");
      return result;
    }
  }

  if (cronJobId) {
    const cronResult = await deleteCronJob(settings, cronJobId);
    result.cronDeleted = cronResult.ok;
    if (!cronResult.ok) result.errors.push(`Cron delete failed: ${cronResult.stderr}`);
  }

  const agentResult = await deleteAgent(settings, agentId);
  result.agentDeleted = agentResult.ok;
  if (!agentResult.ok) result.errors.push(`Agent delete failed: ${agentResult.stderr}`);

  try {
    await removeDir(workspaceDir);
    result.workspaceRemoved = true;
  } catch (error) {
    result.errors.push(`Workspace removal failed: ${(error as Error).message}`);
  }

  if (!keepLogs) {
    try {
      await removeDir(logsDir);
      result.logsRemoved = true;
    } catch (error) {
      result.errors.push(`Logs removal failed: ${(error as Error).message}`);
    }
    try {
      await removeDir(runsDir);
      result.runsRemoved = true;
    } catch (error) {
      result.errors.push(`Runs removal failed: ${(error as Error).message}`);
    }
  }

  result.profileRemoved = await deleteProfileFile(settings, profileId);

  if (!force) {
    const summary = [
      `Cron job: ${cronJobId ? (result.cronDeleted ? "removed" : "FAILED") : "none"}`,
      `Agent: ${result.agentDeleted ? "removed" : "FAILED"}`,
      `Workspace: ${result.workspaceRemoved ? "removed" : "FAILED"}`,
      ...(keepLogs ? [] : [
        `Logs: ${result.logsRemoved ? "removed" : "FAILED"}`,
        `Runs: ${result.runsRemoved ? "removed" : "FAILED"}`
      ]),
      `Profile: ${result.profileRemoved ? "removed" : "FAILED"}`
    ];

    await p.note(summary.join("\n"), "Teardown complete");
  }

  return result;
}

export async function runTeardownAll(
  settings: VaultManagerSettings,
  force?: boolean,
  keepLogs?: boolean
): Promise<void> {
  const profileIds = await listProfileIds(settings);
  if (profileIds.length === 0) {
    p.log.info("No profiles found. Nothing to tear down.");
    return;
  }

  if (!force) {
    await p.note(profileIds.map((id) => `  - ${id}`).join("\n"), "Profiles to tear down");
    const confirmed = await p.confirm({
      message: `Tear down all ${profileIds.length} profile(s)? This cannot be undone.`
    });
    if (p.isCancel(confirmed) || !confirmed) {
      p.cancel("Teardown cancelled.");
      return;
    }
  }

  const results: TeardownResult[] = [];
  for (const profileId of profileIds) {
    results.push(
      await runTeardown({ settings, profileId, force: true, keepLogs })
    );
  }

  const allErrors = results.flatMap((r) => r.errors.map((e) => `[${r.profileId}] ${e}`));
  if (allErrors.length > 0) {
    p.log.warn(`Teardown completed with ${allErrors.length} error(s):\n${allErrors.join("\n")}`);
  } else {
    p.log.info(`Torn down ${results.length} profile(s).`);
  }
}
