import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export async function commandExists(command: string): Promise<boolean> {
  const result = await runCommandWithTimeout(
    ["sh", "-lc", `command -v ${shellEscape(command)} >/dev/null 2>&1`],
    { timeoutMs: 2_000 }
  );
  return result.code === 0;
}

export async function runCommand(
  command: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string }
): Promise<CommandResult> {
  try {
    const result = await runCommandWithTimeout([command, ...args], {
      timeoutMs: 120_000,
      cwd: opts?.cwd,
      env: opts?.env,
      input: opts?.input
    });

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      code: result.code ?? 1
    };
  } catch (error) {
    return {
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      code: 127
    };
  }
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
