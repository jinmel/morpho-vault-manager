function parseArgs(argv: string[]): {
  profileId: string;
} {
  let profileId = "default";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--profile") {
      profileId = argv[index + 1] ?? profileId;
      index += 1;
    }
  }

  return { profileId };
}

async function main(): Promise<void> {
  const { profileId } = parseArgs(process.argv.slice(2));

  const [{ runPlan }, { resolveVaultManagerSettings }] = await Promise.all([
    import(new URL("../lib/rebalance.ts", import.meta.url).href),
    import(new URL("../lib/settings.ts", import.meta.url).href)
  ]);
  const settings = resolveVaultManagerSettings();
  const result = await runPlan(settings, profileId);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
