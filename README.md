# dsh-workspace-drift

`dsh-workspace-drift` is a DeepSeek Harness plugin for finding the environment differences that stop a project from running after it moves to another computer.

It records a project baseline, checks the current machine, and explains differences in plain language. It never saves the values of API keys, passwords, tokens, or `.env` files.

## Install

Install the plugin into a DSH profile:

```sh
dsh plugin --profile web add dsh-workspace-drift
```

For a local checkout during development:

```sh
dsh plugin --profile web add .
```

## Use

Ask the agent to use one of these tools with the absolute path to your project.

### Record a baseline

`environment_snapshot` records the environment that currently works and writes it to:

```text
<workspace>/.dsh/environment-baseline.json
```

Example request:

```text
Record the development environment for E:\Project\my-app.
```

### Check the current machine

`environment_check` inspects the workspace without changing files. It checks project type, installed runtimes, package manager, dependency-ready markers, common start scripts, and required configuration names.

Example request:

```text
Check whether E:\Project\my-app has the environment needed to run.
```

### Compare with the saved baseline

`environment_compare` compares the current workspace with the saved baseline and also performs the current-environment checks. Each finding states what differs, why that may block the project, and the next command or action to take.

Example request:

```text
Compare E:\Project\my-app with its saved environment baseline.
```

## What is collected

- operating-system identifier;
- Node.js, Python, Rust, and Go versions when those tools are installed;
- project types detected from `package.json`, Python project files, `Cargo.toml`, and `go.mod`;
- whether Node dependencies, Python virtual environments, Rust build output, and Go module checksums are present;
- detected package manager and project lockfiles;
- names of package scripts;
- Git branch and commit identifier;
- names from `.env.example`, without their values;
- whether required names are set in the current process environment or local `.env` file, without retaining their values.

## Privacy and limits

The plugin never stores or returns `.env` values, API keys, passwords, access tokens, private keys, or cookies. During a check it reads local `.env` assignments only long enough to determine whether each required name has a non-empty value. It only reads files inside the selected workspace. The first release reads `package.json`, `.env.example`, `.env`, and known lockfile names; it does not install dependencies or modify project files other than its own baseline.

## Baseline format

Baselines use JSON format version `1`. They contain the workspace path, collection time, plugin version, normalized environment facts, dependency-ready markers, and required configuration names, never secret values. The file is written through a temporary file and rename so an interrupted write does not replace the previous baseline with partial JSON. A malformed or unsupported baseline is rejected rather than silently treated as a match.

## What a result means

An empty finding list means the plugin found no critical difference among the facts it can inspect. It does not prove that the project will start, build, connect to a service, or pass tests. The plugin never runs project commands or installs dependencies during a check.

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
```

The development rules and privacy contract are in [AGENTS.md](AGENTS.md).

## Known limitations and deferred work

- Python, Rust, and Go support checks only basic project markers and dependency readiness. It does not parse every ecosystem-specific dependency manager or prove a program can build.
- A matching baseline is evidence of matching recorded facts, not proof that an application will run successfully.
