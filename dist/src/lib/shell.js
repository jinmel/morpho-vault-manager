import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
export async function commandExists(command) {
    const result = await runCommandWithTimeout(["sh", "-lc", `command -v ${shellEscape(command)} >/dev/null 2>&1`], { timeoutMs: 2_000 });
    return result.code === 0;
}
export async function runCommand(command, args, opts) {
    try {
        const result = await runCommandWithTimeout([command, ...args], {
            timeoutMs: 120_000,
            cwd: opts?.cwd,
            env: opts?.env
        });
        return {
            stdout: result.stdout,
            stderr: result.stderr,
            code: result.code ?? 1
        };
    }
    catch (error) {
        return {
            stdout: "",
            stderr: error instanceof Error ? error.message : String(error),
            code: 127
        };
    }
}
export function shellEscape(value) {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}
