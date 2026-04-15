import fs from "node:fs/promises";
const INLINE_TOKEN_STORE = new Map();
export function registerInlineToken(origin, value) {
    INLINE_TOKEN_STORE.set(origin, value);
}
function describeSource(source) {
    if (source.kind === "env")
        return `env:${source.envVar}`;
    if (source.kind === "inline")
        return `inline:${source.origin}`;
    if (source.mode === "json")
        return `file:${source.path}#${source.jsonField ?? "apiKey"}`;
    return `file:${source.path}`;
}
export async function resolveApiToken(source) {
    const description = describeSource(source);
    if (source.kind === "env") {
        const value = process.env[source.envVar];
        if (!value || value.trim().length === 0) {
            return {
                ok: false,
                description,
                error: `Environment variable ${source.envVar} is not set in the current process.`
            };
        }
        return { ok: true, value: value.trim(), description };
    }
    if (source.kind === "inline") {
        const value = INLINE_TOKEN_STORE.get(source.origin);
        if (!value || value.trim().length === 0) {
            return {
                ok: false,
                description,
                error: `Inline token ${source.origin} is no longer registered in this process. Re-run the plugin register phase to re-resolve it.`
            };
        }
        return { ok: true, value: value.trim(), description };
    }
    try {
        const raw = await fs.readFile(source.path, "utf8");
        if (source.mode === "json") {
            const parsed = JSON.parse(raw);
            const field = source.jsonField ?? "apiKey";
            const value = parsed[field];
            if (typeof value !== "string" || value.trim().length === 0) {
                return {
                    ok: false,
                    description,
                    error: `JSON secret file did not contain string field "${field}".`
                };
            }
            return { ok: true, value: value.trim(), description };
        }
        const value = raw.trim();
        if (value.length === 0) {
            return {
                ok: false,
                description,
                error: `Secret file ${source.path} is empty.`
            };
        }
        return { ok: true, value, description };
    }
    catch (error) {
        return {
            ok: false,
            description,
            error: `Failed to read secret file ${source.path}: ${error.message}`
        };
    }
}
export function tokenSourceFromPluginConfig(value, fallbackEnvVar, options = {}) {
    if (typeof value === "string" && value.trim().length > 0) {
        const trimmed = value.trim();
        const looksLikeEnvVarName = /^[A-Z_][A-Z0-9_]*$/.test(trimmed);
        if (looksLikeEnvVarName) {
            return { kind: "env", envVar: trimmed };
        }
        const origin = options.inlineOrigin ?? "plugin-config:apiKey";
        registerInlineToken(origin, trimmed);
        return { kind: "inline", origin };
    }
    if (value && typeof value === "object") {
        const record = value;
        const kind = typeof record.source === "string" ? record.source : record.kind;
        if (kind === "env") {
            const envVar = typeof record.id === "string"
                ? record.id
                : typeof record.envVar === "string"
                    ? record.envVar
                    : fallbackEnvVar;
            return { kind: "env", envVar };
        }
        if (kind === "file") {
            const filePath = typeof record.path === "string"
                ? record.path
                : typeof record.id === "string"
                    ? record.id
                    : "";
            if (filePath.length === 0) {
                return { kind: "env", envVar: fallbackEnvVar };
            }
            const mode = record.mode === "json" ? "json" : "singleValue";
            const jsonField = typeof record.jsonField === "string" ? record.jsonField : undefined;
            return { kind: "file", path: filePath, mode, jsonField };
        }
        if (kind === "exec") {
            return { kind: "env", envVar: fallbackEnvVar };
        }
    }
    return { kind: "env", envVar: fallbackEnvVar };
}
export function describeTokenSource(source) {
    return describeSource(source);
}
