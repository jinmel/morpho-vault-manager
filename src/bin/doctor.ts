import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveVaultManagerSettings } from "../lib/settings.js";
import { describeTokenSource, resolveApiToken } from "../lib/secrets.js";

const execFileAsync = promisify(execFile);

type ProbeStatus = "pass" | "warn" | "fail";

type Probe = {
  id: string;
  status: ProbeStatus;
  description: string;
  details?: Record<string, unknown>;
};

async function probeCommand(command: string, args: string[], label: string): Promise<Probe> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5000 });
    return {
      id: label,
      status: "pass",
      description: `${command} ${args.join(" ")} succeeded`,
      details: { output: stdout.trim().split("\n").slice(0, 2) }
    };
  } catch (error) {
    return {
      id: label,
      status: "fail",
      description: `${command} ${args.join(" ")} failed`,
      details: { error: (error as Error).message }
    };
  }
}

async function probeCommandAvailable(command: string): Promise<Probe> {
  try {
    await execFileAsync("sh", ["-c", `command -v ${command}`], { timeout: 2000 });
    return {
      id: `command:${command}`,
      status: "pass",
      description: `${command} is on PATH`
    };
  } catch {
    return {
      id: `command:${command}`,
      status: "warn",
      description: `${command} is not on PATH`
    };
  }
}

async function probeRepoFile(rootDir: string, relativePath: string): Promise<Probe> {
  const fullPath = path.join(rootDir, relativePath);
  try {
    const stat = await fs.stat(fullPath);
    if (stat.isFile()) {
      return {
        id: `file:${relativePath}`,
        status: "pass",
        description: `${relativePath} exists`
      };
    }
    return {
      id: `file:${relativePath}`,
      status: "fail",
      description: `${relativePath} is not a regular file`
    };
  } catch {
    return {
      id: `file:${relativePath}`,
      status: "fail",
      description: `${relativePath} is missing`
    };
  }
}

async function probeTypecheck(rootDir: string): Promise<Probe> {
  try {
    await execFileAsync("npm", ["run", "-s", "typecheck"], {
      cwd: rootDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024
    });
    return { id: "npm:typecheck", status: "pass", description: "tsc --noEmit succeeded" };
  } catch (error) {
    return {
      id: "npm:typecheck",
      status: "fail",
      description: "tsc --noEmit failed",
      details: { error: (error as Error).message }
    };
  }
}

async function probeLivePath(rootDir: string): Promise<Probe> {
  try {
    const { stdout } = await execFileAsync(
      "scripts/check/live-path",
      ["--format=json"],
      {
        cwd: rootDir,
        timeout: 300_000,
        maxBuffer: 20 * 1024 * 1024
      }
    );
    const jsonStart = stdout.indexOf("{");
    const parsed = JSON.parse(stdout.slice(jsonStart)) as {
      totals?: { pass?: number; fail?: number };
      planStatus?: string;
    };
    if (!parsed.totals || parsed.totals.fail && parsed.totals.fail > 0) {
      return {
        id: "live-path",
        status: "fail",
        description: `live-path reported ${parsed.totals?.fail ?? 0} failing step(s)`
      };
    }
    return {
      id: "live-path",
      status: "pass",
      description: `end-to-end read path verified (planStatus=${parsed.planStatus ?? "n/a"})`
    };
  } catch (error) {
    return {
      id: "live-path",
      status: "warn",
      description: "scripts/check/live-path did not complete",
      details: { error: (error as Error).message }
    };
  }
}

async function probeSandbox(rootDir: string): Promise<Probe> {
  try {
    const { stdout } = await execFileAsync(
      "scripts/dev/sandbox",
      ["--scenario=planned", "--format=json"],
      {
        cwd: rootDir,
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024
      }
    );
    const jsonStart = stdout.indexOf("{");
    const parsed = JSON.parse(stdout.slice(jsonStart)) as { status?: string };
    if (parsed.status !== "planned") {
      return {
        id: "sandbox:planned",
        status: "fail",
        description: `sandbox returned status ${parsed.status ?? "?"} instead of planned`
      };
    }
    return {
      id: "sandbox:planned",
      status: "pass",
      description: "fixture sandbox produces a planned allocation"
    };
  } catch (error) {
    return {
      id: "sandbox:planned",
      status: "fail",
      description: "scripts/dev/sandbox failed",
      details: { error: (error as Error).message }
    };
  }
}

async function probePublishManifest(rootDir: string): Promise<Probe> {
  try {
    await execFileAsync("scripts/check/publish", [], {
      cwd: rootDir,
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024
    });
    return {
      id: "publish:manifest",
      status: "pass",
      description: "scripts/check/publish allowlist/denylist satisfied"
    };
  } catch (error) {
    return {
      id: "publish:manifest",
      status: "fail",
      description: "scripts/check/publish failed",
      details: { error: (error as Error).message }
    };
  }
}

async function probeEvals(rootDir: string): Promise<Probe> {
  try {
    const { stdout } = await execFileAsync("scripts/check/evals", [], {
      cwd: rootDir,
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024
    });
    const passed = (stdout.match(/pass$/gm) ?? []).length;
    return {
      id: "evals:deterministic",
      status: "pass",
      description: `executed ${passed} scenarios`,
      details: { scenarios: passed }
    };
  } catch (error) {
    return {
      id: "evals:deterministic",
      status: "fail",
      description: "scripts/check/evals failed",
      details: { error: (error as Error).message }
    };
  }
}

async function probeTokenSource(): Promise<Probe> {
  const settings = resolveVaultManagerSettings();
  const source = settings.defaultTokenSource;
  const description = describeTokenSource(source);
  const resolution = await resolveApiToken(source);
  if (resolution.ok) {
    return {
      id: "secrets:default-token-source",
      status: "pass",
      description: `resolved ${description}`
    };
  }
  return {
    id: "secrets:default-token-source",
    status: "warn",
    description: `default token source ${description} is not ready (${resolution.error})`
  };
}

async function main(): Promise<void> {
  const rootDir = path.resolve(new URL("../../", import.meta.url).pathname);
  const formatFlag = process.argv.find((arg) => arg.startsWith("--format="));
  const format = formatFlag ? formatFlag.split("=")[1] : "text";

  const probes: Probe[] = [];
  probes.push(await probeCommandAvailable("openclaw"));
  probes.push(await probeCommandAvailable("ows"));
  probes.push(await probeCommandAvailable("bunx"));
  probes.push(await probeCommandAvailable("git"));
  probes.push(await probeRepoFile(rootDir, "package.json"));
  probes.push(await probeRepoFile(rootDir, "openclaw.plugin.json"));
  probes.push(await probeRepoFile(rootDir, "state/progress.json"));
  probes.push(await probeCommand("node", ["--version"], "node:version"));
  probes.push(await probeTypecheck(rootDir));
  probes.push(await probeEvals(rootDir));
  probes.push(await probeSandbox(rootDir));
  probes.push(await probeLivePath(rootDir));
  probes.push(await probePublishManifest(rootDir));
  probes.push(await probeTokenSource());

  const summary = {
    rootDir,
    timestamp: new Date().toISOString(),
    totals: {
      pass: probes.filter((probe) => probe.status === "pass").length,
      warn: probes.filter((probe) => probe.status === "warn").length,
      fail: probes.filter((probe) => probe.status === "fail").length
    },
    probes
  };

  if (format === "json") {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(`[doctor] timestamp ${summary.timestamp}\n`);
    for (const probe of probes) {
      process.stdout.write(`[doctor] ${probe.status.padEnd(4)} ${probe.id} — ${probe.description}\n`);
    }
    process.stdout.write(
      `[doctor] summary pass=${summary.totals.pass} warn=${summary.totals.warn} fail=${summary.totals.fail}\n`
    );
  }

  if (summary.totals.fail > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`[doctor] ${(error as Error).stack ?? (error as Error).message}\n`);
  process.exitCode = 1;
});
