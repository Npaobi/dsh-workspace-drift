# AGENTS.md — dsh-workspace-drift

## Project purpose

`dsh-workspace-drift` is a DeepSeek Harness bundle plugin that records a project's runnable development environment, compares the current machine with a saved baseline, and reports actionable differences without storing secret values.

The first release is intentionally small:

- record a baseline;
- inspect the current environment;
- compare the current environment with the baseline;
- explain differences in plain language.

Do not add a web dashboard, automatic software installation, cloud synchronization, team management, or remote collection until a concrete user requirement and design note justify it.

## Source authority and relationship to Harness

This repository is a standalone plugin project. Do not modify the DeepSeek Harness source tree to implement plugin behavior. Use documented Harness extension points and package APIs.

Before changing integration code, read the vendored Harness guidance available in the development checkout:

- `AGENTS.md` — repository-wide conventions;
- `docs/architecture.md` — Cordis composition, bundles, tools, events, and extension points;
- `docs/cookbook/adding-a-tool.md` — model-facing tool contracts;
- `docs/testing.md` — real-composition, keyless, and user-visible behavior testing.

If this plugin is copied into the Harness monorepo for local integration, the nearest more-specific `AGENTS.md` takes precedence, while these plugin rules remain the product contract.

## Repository layout

Use this layout unless a documented requirement makes a change necessary:

```text
package.json
README.md
cordis.patch.yml
src/
  index.ts
  environment.ts
  types.ts
tests/
  environment.spec.ts
  loader.e2e.ts
```

- `src/types.ts` contains types only.
- `src/index.ts` exports the named function-plugin surface (`name`, `inject`, `Config` when needed, and `apply`); do not add a default export for a function plugin.
- `tests/` is a sibling of `src/`, not `src/__tests__/`.
- Keep generated build output out of source control unless the distribution contract explicitly requires it.

## Runtime and package conventions

- Use ESM (`"type": "module"`) and strict TypeScript with `noImplicitAny`.
- Use Node.js 22.19+ as the development baseline, matching the Harness repository.
- Declare `dsh.bundle` in `package.json` and point it at `cordis.patch.yml`.
- Keep `@deepseek-ai/cordis` as a peer dependency and development dependency when the plugin imports it.
- Prefer maintained dependencies when they remove substantial code and tests; do not add a dependency for a small standard-library operation.
- Do not hardcode deployment-varying values. Put user-selectable limits, baseline path, and scan options in validated plugin configuration.
- Configuration errors must fail at load or at the earliest point where the missing value can be resolved. Never silently ignore a missing baseline or invalid path.
- Use explicit, narrow types at file, process, JSON, and tool boundaries. Validate parsed JSON, configuration, environment-variable names, and command output before using them.
- Keep functions small and deterministic where possible. Pure comparison and formatting logic must not perform I/O, read global state, use the clock, or use randomness.

## Harness plugin and tool design

The plugin is a model-facing capability. Register tools through the Harness tool registry and use the named function-plugin export form required by the Loader.

The initial public tools are:

- `environment_snapshot` — collect and save a baseline for the selected workspace;
- `environment_check` — inspect the current workspace and report missing or incompatible prerequisites;
- `environment_compare` — compare a saved baseline with the current inspection.

Tool contracts:

- Tool descriptions and results use task language understandable to the model and user; do not expose internal class names or transport terms.
- Arguments are validated by the tool schema. Hand-check only constraints the schema cannot express, such as non-empty paths and safe workspace scope.
- Return one canonical JSON value with stable fields. Keep human explanation in the renderer, not in a value that callers must parse.
- Honor `exec.signal` for all foreground I/O and subprocess work.
- Do not mutate tool arguments or registered schemas.
- Register contributions through effects so disposing the plugin unregisters every tool.
- If a tool changes a file, provide a truthful diff-oriented presentation; if it only inspects data, use a generic or search-oriented presentation.
- Presentation functions are pure and replay-safe: no file reads, clocks, random values, or session lookups.
- Any information sent to the model must be reconstructable from the session log. Do not inject hidden, unlogged context.

## Environment and privacy contract

The plugin may collect:

- operating-system identifier;
- Node.js, Python, and package-manager versions;
- package-manager and lockfile names;
- declared project scripts;
- Git branch and commit identifier;
- names of required environment variables, never their values;
- dependency-file metadata and bounded hashes where explicitly configured.

The plugin must never persist or return:

- API keys, passwords, access tokens, private keys, cookie values, or `.env` values;
- full arbitrary file contents unless a future feature explicitly requires it and documents the risk;
- unrelated files outside the selected workspace.

Redaction is a safety requirement, not a best-effort feature. Test common secret-shaped values and verify that both saved files and tool results contain neither the value nor an avoidable substring of it.

Workspace access must be explicit. Resolve paths, reject traversal outside the selected workspace, and report permission or missing-file errors instead of silently continuing. Keep collection bounded by file count, bytes, and subprocess timeouts; expose those limits through validated configuration.

## Baseline format

Use a versioned JSON document stored under the workspace, by default `.dsh/environment-baseline.json`.

The format must contain:

- a numeric format version;
- collection timestamp;
- workspace identity sufficient to detect an accidental baseline from another project;
- normalized environment facts;
- required configuration names without values;
- the plugin version that wrote the baseline.

Treat the format as pre-release and replace it cleanly when it changes. Do not add compatibility readers without a current consumer need. Write atomically, keep exactly one trailing newline, and never replace a valid baseline with a partial file.

## Error and output rules

Diagnostics must answer three questions:

1. What is different?
2. Why might it prevent the project from running?
3. What should the user do next?

Use stable machine-readable severities such as `error`, `warning`, and `info`, with a short human-readable explanation for each finding. Do not claim that a project is runnable merely because a version string matched; distinguish observed facts from inferred advice.

If no baseline exists, say so and explain how to create one. If a fact cannot be inspected, report it as unknown with the reason. Never convert an inspection failure into a false match.

## Testing requirements

Every behavior change needs focused tests. At minimum cover:

- normal snapshot creation;
- comparison with no differences;
- Node.js or package-manager version differences;
- missing required configuration names;
- missing dependencies or project scripts;
- malformed or missing baseline;
- path traversal and workspace-boundary rejection;
- redaction of secrets;
- cancellation and subprocess timeout;
- atomic-write failure without corrupting the previous baseline.

Because the tools are product-visible, add a real Loader/composition smoke that loads the bundle and invokes the published tool path. A hand-built `ctx.plugin(...)` test alone is insufficient. Keep the keyless smoke deterministic; mock only process, clock, or other nondeterministic boundaries.

Tests describe observable behavior, not implementation details. Add a keyless snapshot when tool schemas, model-visible text, durable output, or user-visible rendering changes. Add a with-key test only if a real model interaction is needed; it must self-skip when no key is available.

## Documentation requirements

Keep `README.md` synchronized with the implementation. Document:

- installation through `dsh plugin add`;
- the three tools and example requests;
- baseline location and format version policy;
- what is collected and what is never stored;
- path and size/time limits;
- known limitations and deferred work;
- the checks contributors should run.

Non-trivial changes require an Agent Note in the same change. The note should record the decision, affected contract, alternatives rejected, and verification evidence. Do not edit archived Harness notes; write a new note in this plugin's notes directory if the project adopts one.

## Required checks before publishing

Run the smallest relevant checks and report exactly what was run:

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
pnpm run build
```

Also verify the published artifact through a clean Loader/composition smoke. Before submitting to the awesome list, confirm:

- the repository contains real working code;
- `dsh.bundle` is present;
- the repository is at least one day old and has at least ten commits;
- the GitHub repository has the `dsh-plugin` topic;
- the list entry uses category `dev` and describes behavior accurately;
- no README or generated list file is edited by hand in the awesome-list repository.

## Editing rules

- Use one physical trailing newline per text file.
- Do not commit credentials, local absolute paths, generated secrets, or machine-specific user data.
- Keep TODO markers meaningful: `FIXME` blocks release, `TODO` is planned work, `XXX` is optional future work.
- Comments explain non-obvious contracts, security boundaries, lifecycle ownership, or configuration scope; do not narrate obvious control flow.
- When a rule changes, update this file and the affected README or test contract together.
