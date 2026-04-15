import { spawn } from "node:child_process";

export type CommandResult = {
  stdout: string;
  stderr: string;
  code: number;
};

export async function commandExists(command: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn("sh", ["-lc", `command -v ${shellEscape(command)} >/dev/null 2>&1`], {
      stdio: "ignore"
    });
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function runCommand(
  command: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve) => {
    const child = spawn(command, args, {
      cwd: opts?.cwd,
      env: opts?.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({
        stdout,
        stderr: stderr || (error as NodeJS.ErrnoException).message,
        code: 127
      });
    });
    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        code: code ?? 1
      });
    });
  });
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
