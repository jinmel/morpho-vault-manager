import fs from "node:fs/promises";
import path from "node:path";
import type { VaultManagerSettings } from "./types.js";

export type RunLogPhase =
  | "start"
  | "read"
  | "plan"
  | "prepare"
  | "execute"
  | "verify"
  | "complete"
  | "error";

export type RunLogPayload = Record<string, unknown>;

export type RunLogEvent = {
  timestamp: string;
  runId: string;
  profileId: string;
  mode: string;
  phase: RunLogPhase;
  message: string;
  payload?: RunLogPayload;
};

export type RunLogger = {
  runId: string;
  profileId: string;
  logPath: string;
  event: (phase: RunLogPhase, message: string, payload?: RunLogPayload) => Promise<void>;
  close: () => Promise<void>;
};

const SENSITIVE_KEY_REGEX = /token|secret|passphrase|mnemonic|private[_-]?key|signature/i;
const OWS_KEY_VALUE_REGEX = /\bows_key_[A-Za-z0-9_-]{8,}/g;
const WALLET_CREATE_ECHO_REGEX = /Created wallet[\s\S]*?(?:\n\s*\n|$)/i;

function redactString(value: string): string {
  let next = value.replace(OWS_KEY_VALUE_REGEX, "ows_key_***");
  next = next.replace(WALLET_CREATE_ECHO_REGEX, "[redacted wallet create output]");
  return next;
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const copy: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_REGEX.test(key)) {
        copy[key] = "[redacted]";
      } else {
        copy[key] = redact(inner);
      }
    }
    return copy;
  }
  return value;
}

export function runLogPathFor(
  settings: VaultManagerSettings,
  profileId: string,
  runId: string
): string {
  return path.join(settings.dataRoot, "logs", profileId, `${runId}.jsonl`);
}

export async function createRunLogger(params: {
  settings: VaultManagerSettings;
  profileId: string;
  runId: string;
  mode: string;
  emitToStderr?: boolean;
}): Promise<RunLogger> {
  const logPath = runLogPathFor(params.settings, params.profileId, params.runId);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const handle = await fs.open(logPath, "a");

  async function event(
    phase: RunLogPhase,
    message: string,
    payload?: RunLogPayload
  ): Promise<void> {
    const record: RunLogEvent = {
      timestamp: new Date().toISOString(),
      runId: params.runId,
      profileId: params.profileId,
      mode: params.mode,
      phase,
      message,
      payload: payload ? (redact(payload) as RunLogPayload) : undefined
    };
    const line = `${JSON.stringify(record)}\n`;
    await handle.write(line);
    if (params.emitToStderr) {
      process.stderr.write(line);
    }
  }

  async function close(): Promise<void> {
    await handle.close();
  }

  return {
    runId: params.runId,
    profileId: params.profileId,
    logPath,
    event,
    close
  };
}
