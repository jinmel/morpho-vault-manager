# OpenClaw Morpho Vault Manager Plugin Spec
## Revised Release/Install Addendum

Date: 2026-04-15

Status: Revised addendum to [docs/openclaw-vault-manager-spec.md](./openclaw-vault-manager-spec.md)

Purpose: record release-critical spec corrections discovered during final installation QA without rewriting the original spec.

## Why This Revision Exists

Final release QA found that the original spec was too loose in three areas:

1. it did not explicitly require the packaged plugin to pass OpenClaw's safe-install scanner without `--dangerously-force-unsafe-install`
2. it did not explicitly require the shipped plugin artifact to be executable as installed, rather than relying on unresolved TypeScript source paths
3. it did not distinguish between "plugin metadata/help loads" and "full `openclaw vault-manager ...` command execution works on the claimed minimum gateway version"

This addendum narrows those requirements.

## Revised Non-Negotiable Release Requirements

### 1. No unsafe-install override for release artifacts

Release artifacts must install through:

```bash
openclaw plugins install @morpho/openclaw-vault-manager
```

or an equivalent packed artifact path, without requiring:

```bash
--dangerously-force-unsafe-install
```

If the plugin requires the unsafe override, the release is blocked.

### 2. Installed artifact must execute from built runtime assets

The shipped package must contain a built runtime entrypoint and built runtime modules.

For release:

- `openclaw.extensions` must point at compiled JS
- the installed plugin must not depend on unresolved `.ts` import paths
- the install artifact must remain executable after extraction into `~/.openclaw/extensions/...`

Source TypeScript may still be included for repository ergonomics, but runtime execution must depend on compiled assets.

### 3. Version floor must be proven by full command execution

The minimum supported OpenClaw gateway version is not the first version that can:

- discover the plugin
- show plugin metadata
- print root help text

The minimum supported version is the first version that can successfully complete the supported installed-plugin command path:

- install
- enable
- gateway restart
- `openclaw vault-manager --help`
- `openclaw vault-manager configure ...`
- `openclaw vault-manager status ...`
- `openclaw vault-manager dry-run ...`

If a version only supports metadata/help but fails the command path, it is below the supported floor.

## Revised Packaging Spec

### Runtime packaging requirements

The published package must include:

- compiled plugin entrypoint
- compiled CLI/runtime modules
- plugin manifest
- required runtime scripts
- required skills and references
- operator-facing release documentation

The published package must exclude:

- eval-only entrypoints
- dev-only binaries
- local state files
- progress tracking files
- env files
- implementation-only fixtures not needed at runtime

### Build requirement

`npm pack` for the release candidate must build the runtime artifact as part of packaging.

The release process must not rely on a human remembering to build first.

## Revised Install Acceptance Criteria

The plugin is release-ready only when all of the following are true on a clean supported environment:

1. `openclaw plugins install @morpho/openclaw-vault-manager` succeeds without unsafe override
2. `openclaw plugins enable morpho-vault-manager` succeeds
3. `openclaw gateway restart` succeeds
4. `openclaw vault-manager --help` shows the expected subcommands
5. `openclaw vault-manager configure` starts successfully from the installed plugin
6. the installed plugin can execute its runtime modules without module-resolution errors
7. the package does not require repo-local source layout assumptions after install

## Revised Compatibility Statement

The compatibility floor must be documented as the exact OpenClaw version validated by the full command path above.

The plugin must not claim compatibility with older versions based only on:

- successful install
- successful plugin inspection
- successful root command descriptor display

At the time of this revision, installation QA showed that OpenClaw `2026.4.2` was not sufficient for full installed-plugin command execution. The release floor must therefore remain at the newer validated line until proven otherwise.

## Revised Release QA Requirements

Release QA must explicitly include:

- packed-artifact install test
- safe-install verification with no unsafe override
- post-restart command execution through `openclaw`
- command-level verification on the declared minimum supported gateway version

Repository-local checks such as typecheck, evals, and package allowlist verification remain necessary but are not sufficient by themselves.

## Revised Source of Truth Rule

For distribution and installability, the source of truth is:

1. the packed artifact contents
2. the installed plugin behavior inside OpenClaw
3. the verified gateway version used during release QA

Repository source layout is not sufficient evidence for release claims if the packed artifact behaves differently after installation.

## Required Release Gate

Before publish, the release process must fail closed unless all of the following pass:

```bash
npm run typecheck
scripts/check/evals
scripts/check/publish
npm pack
openclaw plugins install <packed artifact>
openclaw plugins enable morpho-vault-manager
openclaw gateway restart
openclaw vault-manager --help
```

and then the configured post-install command checks on the declared supported OpenClaw version.

## Scope of This Revision

This addendum changes release, packaging, and compatibility requirements only.

It does not change:

- Base-only scope
- USDC-only scope
- Morpho-only vault-management scope
- OWS-only signing requirements
- rebalance policy and security invariants
