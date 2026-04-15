import fs from "node:fs/promises";
import path from "node:path";
const SENSITIVE_KEY_REGEX = /token|secret|passphrase|mnemonic|private[_-]?key|signature/i;
function redact(value) {
    if (Array.isArray(value))
        return value.map(redact);
    if (value && typeof value === "object") {
        const copy = {};
        for (const [key, inner] of Object.entries(value)) {
            if (SENSITIVE_KEY_REGEX.test(key)) {
                copy[key] = "[redacted]";
            }
            else {
                copy[key] = redact(inner);
            }
        }
        return copy;
    }
    return value;
}
export function runLogPathFor(settings, profileId, runId) {
    return path.join(settings.dataRoot, "logs", profileId, `${runId}.jsonl`);
}
export async function createRunLogger(params) {
    const logPath = runLogPathFor(params.settings, params.profileId, params.runId);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const handle = await fs.open(logPath, "a");
    async function event(phase, message, payload) {
        const record = {
            timestamp: new Date().toISOString(),
            runId: params.runId,
            profileId: params.profileId,
            mode: params.mode,
            phase,
            message,
            payload: payload ? redact(payload) : undefined
        };
        const line = `${JSON.stringify(record)}\n`;
        await handle.write(line);
        if (params.emitToStderr) {
            process.stderr.write(line);
        }
    }
    async function close() {
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
