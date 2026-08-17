import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { accessSync, constants, existsSync } from 'node:fs'
import { dirname, join, resolve, relative, sep } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { EnvironmentSnapshot, Finding } from './types.ts'
import type { ProjectKind } from './types.ts'

const execFileAsync = promisify(execFile)
const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'poetry.lock', 'Cargo.lock']
const BASELINE = '.dsh/environment-baseline.json'
const START_SCRIPTS = ['dev', 'start', 'serve', 'build']
const WRITER_VERSION = '0.1.0'

/** Return the default baseline path inside a workspace. */
export function baselinePath(workspace: string): string {
  return join(resolve(workspace), BASELINE)
}

function insideWorkspace(workspace: string, candidate: string): boolean {
  const root = resolve(workspace)
  const target = resolve(candidate)
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..')
}

async function command(command: string, args: string[], signal?: AbortSignal): Promise<string | null> {
  try {
    const result = await execFileAsync(command, args, { encoding: 'utf8', timeout: 10_000, signal })
    return result.stdout.trim() || null
  } catch {
    return null
  }
}

function detectedPackageManager(lockfiles: readonly string[]): string {
  if (lockfiles.includes('pnpm-lock.yaml')) return 'pnpm'
  if (lockfiles.includes('yarn.lock')) return 'yarn'
  if (lockfiles.includes('bun.lockb')) return 'bun'
  return 'npm'
}

function projectKinds(workspace: string): ProjectKind[] {
  const root = resolve(workspace)
  const kinds: ProjectKind[] = []
  if (existsSync(join(root, 'package.json'))) kinds.push('node')
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'Pipfile'))) kinds.push('python')
  if (existsSync(join(root, 'Cargo.toml'))) kinds.push('rust')
  if (existsSync(join(root, 'go.mod'))) kinds.push('go')
  return kinds.length ? kinds : ['unknown']
}

function dependencyState(workspace: string, projects: readonly ProjectKind[]): Record<ProjectKind, boolean> {
  const root = resolve(workspace)
  return {
    node: !projects.includes('node') || existsSync(join(root, 'node_modules')),
    python: !projects.includes('python') || existsSync(join(root, '.venv')) || existsSync(join(root, 'venv')),
    rust: !projects.includes('rust') || existsSync(join(root, 'target')),
    go: !projects.includes('go') || existsSync(join(root, 'go.sum')),
    unknown: true,
  }
}

function packageData(text: string): { scripts: string[]; requiredEnvironmentVariables: string[] } {
  try {
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return { scripts: [], requiredEnvironmentVariables: [] }
    const record = parsed as { scripts?: unknown }
    const scripts = record.scripts && typeof record.scripts === 'object'
      ? Object.keys(record.scripts as object).sort()
      : []
    return { scripts, requiredEnvironmentVariables: [] }
  } catch {
    return { scripts: [], requiredEnvironmentVariables: [] }
  }
}

function configuredNames(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/)
    if (match === null) continue
    const value = match[2].trim().replace(/^(?:"(.*)"|'(.*)')$/, '$1$2').trim()
    if (value) names.push(match[1])
  }
  return names
}

async function configuredEnvironmentNames(workspace: string): Promise<Set<string>> {
  const localEnv = await readFile(join(resolve(workspace), '.env'), 'utf8').catch(() => '')
  const names = new Set(configuredNames(localEnv))
  for (const [name, value] of Object.entries(process.env)) {
    if (value?.trim()) names.add(name)
  }
  return names
}

/** Collect bounded, secret-free facts from one workspace. */
export async function collectSnapshot(workspace: string, signal?: AbortSignal): Promise<EnvironmentSnapshot> {
  const root = resolve(workspace)
  const packageText = await readFile(join(root, 'package.json'), 'utf8').catch(() => null)
  const packageDataResult = packageText ? packageData(packageText) : { scripts: [], requiredEnvironmentVariables: [] }
  const envExample = await readFile(join(root, '.env.example'), 'utf8').catch(() => '')
  const requiredEnvironmentVariables = [...new Set(
    envExample.split(/\r?\n/).map((line: string) => line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/)?.[1]).filter((x: string | undefined): x is string => Boolean(x)),
  )].sort()
  const lockfiles = LOCKFILES.filter(file => { try { accessSync(join(root, file), constants.F_OK); return true } catch { return false } })
  const projects = projectKinds(root)
  const packageManager = detectedPackageManager(lockfiles)
  const node = await command('node', ['--version'], signal) ?? 'unknown'
  const python = await command('python', ['--version'], signal) ?? await command('python3', ['--version'], signal)
  const rust = await command('rustc', ['--version'], signal)
  const go = await command('go', ['version'], signal)
  const packageManagerVersion = await command(packageManager, ['--version'], signal)
  const gitBranch = await command('git', ['-C', root, 'branch', '--show-current'], signal)
  const gitCommit = await command('git', ['-C', root, 'rev-parse', 'HEAD'], signal)
  return {
    version: 1,
    collectedAt: new Date().toISOString(),
    workspace: root,
    writerVersion: WRITER_VERSION,
    platform: process.platform,
    node,
    python,
    packageManager,
    packageManagerVersion,
    projects,
    dependenciesInstalled: dependencyState(root, projects),
    rust,
    go,
    lockfiles,
    scripts: packageDataResult.scripts,
    requiredEnvironmentVariables,
    gitBranch,
    gitCommit,
  }
}

/** Compare two snapshots and produce actionable findings. */
export function compareSnapshots(expected: EnvironmentSnapshot, actual: EnvironmentSnapshot): Finding[] {
  const findings: Finding[] = []
  if (expected.projects.join(',') !== actual.projects.join(',')) findings.push({ severity: 'warning', field: 'projects', message: `Project types differ: expected ${expected.projects.join(', ')}, found ${actual.projects.join(', ')}.`, advice: 'Compare the same checkout and restore its project manifest files before diagnosing environment differences.' })
  if (expected.node !== actual.node) findings.push({ severity: 'error', field: 'node', message: `Node.js version differs: expected ${expected.node}, found ${actual.node}.`, advice: 'Install or select the Node.js version recorded by the baseline.' })
  if (expected.python !== actual.python) findings.push({ severity: 'warning', field: 'python', message: `Python version differs: expected ${expected.python ?? 'not detected'}, found ${actual.python ?? 'not detected'}.`, advice: 'Install or select the Python version required by the project.' })
  if (expected.rust !== actual.rust) findings.push({ severity: 'warning', field: 'rust', message: `Rust version differs: expected ${expected.rust ?? 'not detected'}, found ${actual.rust ?? 'not detected'}.`, advice: 'Install or select the Rust version recorded by the baseline.' })
  if (expected.go !== actual.go) findings.push({ severity: 'warning', field: 'go', message: `Go version differs: expected ${expected.go ?? 'not detected'}, found ${actual.go ?? 'not detected'}.`, advice: 'Install or select the Go version recorded by the baseline.' })
  if (expected.packageManager !== actual.packageManager) findings.push({ severity: 'error', field: 'packageManager', message: `Package manager differs: expected ${expected.packageManager}, found ${actual.packageManager}.`, advice: 'Use the package manager selected by the project lockfile.' })
  if (expected.packageManagerVersion !== actual.packageManagerVersion) findings.push({ severity: 'warning', field: 'packageManagerVersion', message: `Package manager version differs: expected ${expected.packageManagerVersion ?? 'not detected'}, found ${actual.packageManagerVersion ?? 'not detected'}.`, advice: 'Use the package manager version recorded by the baseline when dependency installation behaves differently.' })
  if (expected.gitCommit !== actual.gitCommit) findings.push({ severity: 'warning', field: 'gitCommit', message: `Git commit differs: expected ${expected.gitCommit ?? 'not detected'}, found ${actual.gitCommit ?? 'not detected'}.`, advice: 'Check out the same commit before comparing environment failures.' })
  for (const kind of expected.projects.filter(kind => kind !== 'unknown')) {
    if (expected.dependenciesInstalled[kind] && !actual.dependenciesInstalled[kind]) {
      findings.push({ severity: 'error', field: `dependencies:${kind}`, message: `${kind} dependencies were available when the baseline was recorded but are not ready now.`, advice: dependencyAdvice(kind, actual.packageManager) })
    }
  }
  for (const name of expected.requiredEnvironmentVariables.filter(name => !actual.requiredEnvironmentVariables.includes(name))) findings.push({ severity: 'error', field: `env:${name}`, message: `Required configuration name ${name} is not declared by the current workspace.`, advice: `Add ${name} according to the project's .env.example; the plugin never stores its value.` })
  for (const lockfile of expected.lockfiles.filter(file => !actual.lockfiles.includes(file))) findings.push({ severity: 'warning', field: `lockfile:${lockfile}`, message: `Expected lockfile ${lockfile} is missing.`, advice: 'Restore the project lockfile before installing dependencies.' })
  return sortFindings(findings)
}

/** Inspect runnable prerequisites that do not require an existing baseline. */
export async function checkSnapshot(workspace: string, snapshot: EnvironmentSnapshot): Promise<Finding[]> {
  const findings: Finding[] = []
  if (snapshot.projects.includes('unknown')) findings.push({ severity: 'warning', field: 'project', message: 'This folder was not recognized as a Node, Python, Rust, or Go project.', advice: 'Select a project folder containing package.json, pyproject.toml, Cargo.toml, or go.mod.' })
  if (snapshot.projects.includes('node') && snapshot.node === 'unknown') findings.push({ severity: 'error', field: 'node', message: 'Node.js was not detected for this Node project.', advice: 'Install Node.js 22 or newer.' })
  if (snapshot.projects.includes('node') && snapshot.packageManagerVersion === null) findings.push({ severity: 'error', field: 'packageManager', message: `The project uses ${snapshot.packageManager}, but it is not available on this machine.`, advice: `Install ${snapshot.packageManager}, then install dependencies with ${snapshot.packageManager} install.` })
  for (const kind of snapshot.projects.filter(kind => kind !== 'unknown')) {
    if (!snapshot.dependenciesInstalled[kind]) findings.push({ severity: 'error', field: `dependencies:${kind}`, message: `${kind} dependencies are not ready.`, advice: dependencyAdvice(kind, snapshot.packageManager) })
  }
  if (snapshot.projects.includes('python') && snapshot.python === null) findings.push({ severity: 'error', field: 'python', message: 'Python was not detected for this Python project.', advice: 'Install Python, then create and activate a project virtual environment.' })
  if (snapshot.projects.includes('rust') && snapshot.rust === null) findings.push({ severity: 'error', field: 'rust', message: 'Rust was not detected for this Rust project.', advice: 'Install Rust using rustup, then run cargo build.' })
  if (snapshot.projects.includes('go') && snapshot.go === null) findings.push({ severity: 'error', field: 'go', message: 'Go was not detected for this Go project.', advice: 'Install Go, then run go mod download.' })
  if (!snapshot.scripts.some(script => START_SCRIPTS.includes(script))) findings.push({ severity: 'warning', field: 'scripts', message: 'No common start, development, or build script was found.', advice: 'Check package.json for the command this project uses to run or build.' })
  const availableNames = await configuredEnvironmentNames(workspace)
  for (const name of snapshot.requiredEnvironmentVariables.filter(name => !availableNames.has(name))) {
    findings.push({ severity: 'error', field: `env:${name}`, message: `Required configuration ${name} is not configured.`, advice: `Copy .env.example to .env or set ${name}; this plugin never returns or saves its value.` })
  }
  return sortFindings(findings)
}

/** Return a stable severity-first ordering for user-visible findings. */
export function sortFindings(findings: Finding[]): Finding[] {
  return findings.slice().sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.field.localeCompare(b.field))
}

function dependencyAdvice(kind: ProjectKind, packageManager: string | null): string {
  if (kind === 'node') return `Run ${packageManager ?? 'npm'} install in the workspace.`
  if (kind === 'python') return 'Create a virtual environment, activate it, then install the project requirements.'
  if (kind === 'rust') return 'Run cargo build to download and compile Rust dependencies.'
  if (kind === 'go') return 'Run go mod download to fetch Go module dependencies.'
  return 'Install the dependencies required by this project.'
}

function severityRank(severity: Finding['severity']): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2
}

/** Read a versioned baseline and reject malformed or out-of-scope files. */
export async function readBaseline(workspace: string): Promise<EnvironmentSnapshot> {
  const file = baselinePath(workspace)
  if (!insideWorkspace(workspace, file)) throw new Error('Baseline path escapes the workspace.')
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      throw new Error('No baseline was found. Run environment_snapshot before environment_compare.')
    }
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Baseline is malformed or has an unsupported format version.')
  }
  if (!isSnapshot(parsed)) throw new Error('Baseline is missing, malformed, or has an unsupported format version.')
  return parsed
}

function isSnapshot(value: unknown): value is EnvironmentSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<EnvironmentSnapshot>
  return candidate.version === 1
    && typeof candidate.workspace === 'string'
    && typeof candidate.writerVersion === 'string'
    && Array.isArray(candidate.projects)
    && Array.isArray(candidate.lockfiles)
    && Array.isArray(candidate.scripts)
    && Array.isArray(candidate.requiredEnvironmentVariables)
    && candidate.dependenciesInstalled !== null
    && typeof candidate.dependenciesInstalled === 'object'
}

/** Atomically save a baseline, preserving the previous valid file on failure. */
export async function writeBaseline(workspace: string, snapshot: EnvironmentSnapshot): Promise<string> {
  const file = baselinePath(workspace)
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  await rename(temporary, file)
  return file
}
