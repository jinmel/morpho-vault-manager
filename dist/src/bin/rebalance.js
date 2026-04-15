function parseArgs(argv) {
    const [modeArg, ...rest] = argv;
    if (modeArg !== "dry-run" && modeArg !== "live") {
        throw new Error("Usage: node src/bin/rebalance.ts <dry-run|live> [--profile <id>] [--allow-live]");
    }
    let profileId = "default";
    let allowLive = false;
    for (let index = 0; index < rest.length; index += 1) {
        const arg = rest[index];
        if (arg === "--profile") {
            profileId = rest[index + 1] ?? profileId;
            index += 1;
            continue;
        }
        if (arg === "--allow-live") {
            allowLive = true;
        }
    }
    return {
        mode: modeArg,
        profileId,
        allowLive
    };
}
async function main() {
    const { mode, profileId, allowLive } = parseArgs(process.argv.slice(2));
    if (mode === "live" && !allowLive) {
        throw new Error("Live execution requires --allow-live.");
    }
    const [{ runRebalance }, { resolveVaultManagerSettings }] = await Promise.all([
        import(new URL("../lib/rebalance.ts", import.meta.url).href),
        import(new URL("../lib/settings.ts", import.meta.url).href)
    ]);
    const settings = resolveVaultManagerSettings();
    const result = await runRebalance(settings, profileId, mode);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
});
export {};
