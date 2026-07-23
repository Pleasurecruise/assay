# Naming Conventions

Consistency is enforced at boundaries, not by forcing every language into one
style.

## Repository Paths

| Item                        | Convention            | Example                |
| --------------------------- | --------------------- | ---------------------- |
| Documentation files         | `UPPER_SNAKE_CASE.md` | `DATA_ACCESS.md`       |
| Conventional root documents | Established names     | `README.md`, `LICENSE` |
| Directories                 | `kebab-case`          | `agent-runtime`        |
| TypeScript source files     | `kebab-case.ts`       | `market-data-tool.ts`  |
| TypeScript packages         | `@assay/kebab-case`   | `@assay/agent-runtime` |
| Python distribution names   | `kebab-case`          | `assay-panda-adapter`  |
| Python packages and modules | `snake_case`          | `panda_adapter`        |

Documentation filename words must use ASCII uppercase letters, digits, and
underscores. The `.md` extension remains lowercase.

## TypeScript

| Item                           | Convention             | Example              |
| ------------------------------ | ---------------------- | -------------------- |
| Variables and functions        | `camelCase`            | `createRuntime`      |
| Classes, types, and interfaces | `PascalCase`           | `RuntimeTaskRequest` |
| Constants                      | `SCREAMING_SNAKE_CASE` | `DEFAULT_TIMEOUT_MS` |
| Agent IDs                      | `kebab-case`           | `market-researcher`  |
| Tool IDs                       | `snake_case`           | `market_data`        |

Do not add `I` prefixes to interfaces. Boolean names should describe a true
state, such as `isInitialized`, `hasApproval`, or `canRetry`.

## Python

Follow PEP 8:

| Item                                        | Convention             | Example             |
| ------------------------------------------- | ---------------------- | ------------------- |
| Packages, modules, functions, and variables | `snake_case`           | `get_market_data`   |
| Classes and exceptions                      | `PascalCase`           | `PandaDataClient`   |
| Constants                                   | `SCREAMING_SNAKE_CASE` | `DEFAULT_ROW_LIMIT` |
| Private members                             | Leading underscore     | `_sdk_module`       |

## Protocols and Storage

- Public A2A and JSON fields use `camelCase` unless an external protocol
  explicitly requires another spelling.
- Python converts protocol `camelCase` fields to internal `snake_case` at the
  adapter boundary.
- Environment variables use `SCREAMING_SNAKE_CASE`, for example
  `PANDA_DATA_USERNAME`.
- Database tables and columns use `snake_case`.
- Stable event names use dotted lowercase namespaces, for example
  `runtime.tool.started`.

Never silently translate stable identifiers. Agent IDs, tool IDs, event names,
and schema field names are API contracts and require a migration when changed.
