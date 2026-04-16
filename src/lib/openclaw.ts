import { runCommand } from "./shell.js";
import type { VaultManagerProfile, VaultManagerSettings } from "./types.js";

type TelegramGroupTarget = {
  id: string;
  label: string;
};

function parseJson<T>(value: string): T | null {
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isNonEmptyString(value)) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeTelegramGroupEntry(entry: unknown): TelegramGroupTarget | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const record = entry as Record<string, unknown>;
  const id =
    stringField(record, ["id", "groupId", "target", "peerId", "chatId"]) ??
    (typeof record.topicId === "number" && isNonEmptyString(record.chatId)
      ? `${record.chatId}:topic:${record.topicId}`
      : undefined);
  if (!id) {
    return null;
  }

  const label =
    stringField(record, ["name", "title", "displayName", "label"]) ??
    (typeof record.topicId === "number" && isNonEmptyString(record.chatId)
      ? `${record.chatId} topic ${record.topicId}`
      : id);

  return { id, label };
}

export function resolveCronDelivery(profile: VaultManagerProfile, settings: VaultManagerSettings): {
  mode: "announce" | "none";
  channel?: string;
  to?: string;
  accountId?: string;
} {
  if (profile.notifications !== "announce") {
    return { mode: "none" };
  }

  const channel = profile.deliveryChannel ?? settings.defaultDeliveryChannel ?? "last";
  const to = channel === "last" ? undefined : profile.deliveryTo ?? settings.defaultDeliveryTo;
  const accountId = channel === "last" ? undefined : profile.deliveryAccountId ?? settings.defaultDeliveryAccountId;

  if (channel !== "last" && !to) {
    throw new Error(
      `Profile ${profile.profileId} is configured for announce delivery but is missing a destination target.`
    );
  }

  if (!channel && to) {
    throw new Error(
      `Profile ${profile.profileId} has a delivery target but no delivery channel configured.`
    );
  }

  return { mode: "announce", channel, to, accountId };
}

export function buildCronDeliveryArgs(profile: VaultManagerProfile, settings: VaultManagerSettings): string[] {
  const delivery = resolveCronDelivery(profile, settings);
  if (delivery.mode === "none") {
    return ["--no-deliver"];
  }

  return [
    "--announce",
    ...(delivery.channel ? ["--channel", delivery.channel] : []),
    ...(delivery.accountId ? ["--account", delivery.accountId] : []),
    ...(delivery.to ? ["--to", delivery.to] : [])
  ];
}

export async function setEnvVar(
  settings: VaultManagerSettings,
  name: string,
  value: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommand(settings.openclawCommand, [
    "config",
    "set",
    `env.vars.${name}`,
    value
  ]);
  return { ok: result.code === 0, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

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
      `Execute the Morpho vault rebalance program described in AGENTS.md for profile ${params.profile.profileId}.`,
      `Start by calling: openclaw vault-manager plan --profile ${params.profile.profileId} --json`,
      `If the plan status is "planned", follow the execution steps in AGENTS.md to prepare, sign, and broadcast each action using morpho-cli and OWS.`,
      `If the plan status is "no_op" or "blocked", summarize the reasons and stop.`,
      "Report all actions taken, transaction hashes, or explicit no-op/block reasons."
    ].join(" "),
    "--light-context",
    ...buildCronDeliveryArgs(params.profile, params.settings),
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

export async function listConfiguredTelegramAccounts(settings: VaultManagerSettings): Promise<string[]> {
  const result = await runCommand(settings.openclawCommand, ["channels", "list", "--json"]);
  if (result.code !== 0) {
    return [];
  }

  const parsed = parseJson<Record<string, unknown>>(result.stdout);
  const chat = parsed?.chat;
  if (!chat || typeof chat !== "object") {
    return [];
  }

  const telegram = (chat as Record<string, unknown>).telegram;
  if (!Array.isArray(telegram)) {
    return [];
  }

  return telegram.filter(isNonEmptyString).map((value) => value.trim());
}

export async function listTelegramGroups(
  settings: VaultManagerSettings,
  accountId?: string
): Promise<TelegramGroupTarget[]> {
  const result = await runCommand(settings.openclawCommand, [
    "directory",
    "groups",
    "list",
    "--channel",
    "telegram",
    ...(accountId ? ["--account", accountId] : []),
    "--json"
  ]);
  if (result.code !== 0) {
    return [];
  }

  const parsed = parseJson<unknown>(result.stdout);
  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed
    .map(normalizeTelegramGroupEntry)
    .filter((entry): entry is TelegramGroupTarget => entry !== null);
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

export async function deleteCronJob(
  settings: VaultManagerSettings,
  cronJobId: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommand(settings.openclawCommand, ["cron", "remove", cronJobId, "--json"]);
  if (result.code === 0) {
    const parsed = parseJson<Record<string, unknown>>(result.stdout);
    const removed = parsed?.removed;
    const ok = parsed?.ok;
    if (removed === false && ok === true) {
      return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
    }
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

export async function installSkill(params: {
  workspaceDir: string;
  slug: string;
  force?: boolean;
}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const result = await runCommand("clawhub", [
    "--workdir",
    params.workspaceDir,
    "install",
    params.slug,
    ...(params.force ? ["--force"] : [])
  ]);
  return {
    ok: result.code === 0,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim()
  };
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
