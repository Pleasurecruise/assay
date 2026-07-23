# Toolchain

## Ownership

mise selects repository runtimes. Bun executes the oh-my-pi runtime and manages
the JavaScript workspace. Vite+ provides the TypeScript development toolchain.
uv manages the isolated PandaData Python environment.

| Concern                                                  | Tool  |
| -------------------------------------------------------- | ----- |
| Runtime versions                                         | mise  |
| Agent runtime and npm package manager                    | Bun   |
| TypeScript formatting, linting, type checking, and tests | Vite+ |
| Python dependency resolution and virtual environment     | uv    |

## Version Policy

- npm registry dependencies use exact versions without `^`, `~`, `*`, or
  version ranges.
- Workspace dependencies use `workspace:*` because their version is resolved
  inside the monorepo rather than from npm.
- Bun, Node.js, and uv follow mise `latest`.
- Python follows the latest 3.12 patch because PandaData 0.0.12 requires
  `numpy<2`, whose final release line supports Python through 3.12.
- Python dependencies are locked in `services/panda-adapter/uv.lock`.
- Dependency upgrades are explicit changes that must regenerate the relevant
  lockfile and pass the full check command.

## Commands

```bash
mise install
mise exec -- bun install
mise exec -- bun run check
```

The root check runs:

1. `vp check` for formatting, linting, and TypeScript type checks.
2. `vp test` for TypeScript unit tests.
3. Python adapter unit tests through uv.

Use `mise exec -- bun run typecheck` when only a TypeScript type check is
needed. Vite+ remains the command entry point; direct `tsc` and standalone
Vitest commands are not part of the repository workflow.

Formatting is configured in the root `vite.config.ts` and enforced by
`vp check`. The repository uses double quotes, semicolons, trailing commas,
two-space indentation, and a 100-column print width. Run
`mise exec -- bun run fmt` for formatting or
`mise exec -- bun run vp check --fix` to format and apply safe lint fixes.
