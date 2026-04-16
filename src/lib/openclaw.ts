import { runCommand } from "./shell.js";
import type { VaultManagerProfile, VaultManagerSettings } from "./types.js";

export async function openclawGatewayIsReachable(settings: VaultManagerSettings): Promise<boolean> {
  const result = await runCommand(settings.openclawCommand, ["gateway", "status"]);
  return result.code === 0;
}

export async function ensureAgent(params: {
  settings: VaultManagerSettings;
  agentId: string;
  workspaceDir: string;
  modelPreference?: string;
}): Promise<{ ok: boolean; created: boolean; stdout: string; stderr: string }> {
  const result = await runCommand(params.settings.openclawCommand, [
    "agents",
    "add",
    params.agentId,
    "--workspace",
    params.workspaceDir,
    ...(params.modelPreference ? ["--model", params.modelPreference] : []),
    "--non-interactive",
    "--json"
  ]);

  if (result.code === 0) {
    return { ok: true, created: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }

  const alreadyExists = /already exists|duplicate/i.test(`${result.stdout}\n${result.stderr}`);
  return {
    ok: alreadyExists,
    created: false,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

export async function upsertCronJob(params: {
  settings: VaultManagerSettings;
  profile: VaultManagerProfile;
}): Promise<{ ok: boolean; created: boolean; jobId?: string; stdout: string; stderr: string }> {
  const baseArgs = [
    "cron",
    params.profile.cronJobId ? "edit" : "add",
    ...(params.profile.cronJobId ? [params.profile.cronJobId] : []),
    ...(params.profile.cronJobId ? [] : ["--name", params.profile.cronJobName]),
    "--cron",
    params.profile.cronExpression,
    "--tz",
    params.profile.timezone,
    "--session",
    "isolated",
    "--agent",
    params.profile.agentId,
    ...(params.profile.modelPreference ? ["--model", params.profile.modelPreference] : []),
    "--message",
    [
      `Execute the Morpho vault rebalance program in AGENTS.md for profile ${params.profile.profileId}.`,
      `Start with: openclaw vault-manager dry-run --profile ${params.profile.profileId} --json`,
      `If the dry-run status is planned and AGENTS.md allows live execution, continue with: openclaw vault-manager live-run --profile ${params.profile.profileId} --allow-live --json`,
      "Report actions taken, receipts, or explicit no-op/block reasons."
    ].join(" "),
    "--light-context",
    ...(params.profile.notifications === "announce" ? ["--announce"] : ["--no-deliver"]),
    ...(params.profile.cronEnabled ? [] : params.profile.cronJobId ? ["--disable"] : ["--disabled"])
  ];

  const isCreate = !params.profile.cronJobId;
  const result = await runCommand(params.settings.openclawCommand, [
    ...baseArgs,
    ...(isCreate ? ["--json"] : [])
  ]);
  const output = `${result.stdout}\n${result.stderr}`;

  let jobId: string | undefined;
  try {
    const parsed = JSON.parse(result.stdout);
    if (typeof parsed?.id === "string") {
      jobId = parsed.id;
    } else if (typeof parsed?.job?.id === "string") {
      jobId = parsed.job.id;
    }
  } catch {
    const match = output.match(/[a-zA-Z0-9_-]{8,}/);
    jobId = match?.[0];
  }

  return {
    ok: result.code === 0,
    created: !params.profile.cronJobId,
    jobId,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

export async function enableCronJob(settings: VaultManagerSettings, cronJobId: string): Promise<boolean> {
  const result = await runCommand(settings.openclawCommand, ["cron", "enable", cronJobId]);
  return result.code === 0;
}

export async function disableCronJob(settings: VaultManagerSettings, cronJobId: string): Promise<boolean> {
  const result = await runCommand(settings.openclawCommand, ["cron", "disable", cronJobId]);
  return result.code === 0;
}

export async function runCronJobNow(settings: VaultManagerSettings, cronJobId: string): Promise<string> {
  const result = await runCommand(settings.openclawCommand, ["cron", "run", cronJobId]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "failed to enqueue cron run");
  }
  return result.stdout.trim() || result.stderr.trim();
}

export type McpServerProbe = {
  exists: boolean;
  raw?: string;
};

export async function mcpShowServer(
  settings: VaultManagerSettings,
  name: string
): Promise<McpServerProbe> {
  const result = await runCommand(settings.openclawCommand, ["mcp", "show", name]);
  if (result.code === 0) {
    return { exists: true, raw: result.stdout.trim() };
  }
  return { exists: false };
}

export type McpSetResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
};

export async function mcpSetHttpServer(params: {
  settings: VaultManagerSettings;
  name: string;
  url: string;
}): Promise<McpSetResult> {
  const payload = JSON.stringify({ url: params.url });
  const result = await runCommand(params.settings.openclawCommand, [
    "mcp",
    "set",
    params.name,
    payload
  ]);
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
}

export async function deleteCronJob(
  settings: VaultManagerSettings,
  cronJobId: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommand(settings.openclawCommand, ["cron", "delete", cronJobId, "--force"]);
  if (result.code === 0) {
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const notFound = /not found|does not exist|no such/i.test(output);
  return { ok: notFound, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export async function deleteAgent(
  settings: VaultManagerSettings,
  agentId: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommand(settings.openclawCommand, ["agents", "delete", agentId, "--force"]);
  if (result.code === 0) {
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const notFound = /not found|does not exist|no such/i.test(output);
  return { ok: notFound, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export async function mcpUnsetServer(
  settings: VaultManagerSettings,
  name: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommand(settings.openclawCommand, ["mcp", "unset", name]);
  if (result.code === 0) {
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const notFound = /not found|does not exist|no such/i.test(output);
  return { ok: notFound, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

export async function listCronJobs(settings: VaultManagerSettings): Promise<unknown[] | null> {
  const result = await runCommand(settings.openclawCommand, ["cron", "list", "--all", "--json"]);
  if (result.code !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed?.jobs)) {
      return parsed.jobs;
    }
  } catch {
    return null;
  }

  return null;
}
