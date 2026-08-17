import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as workspaceDrift from '../src/index.ts'
import { checkSnapshot, collectSnapshot, compareSnapshots, readBaseline, writeBaseline } from '../src/environment.ts'
import { baselinePath } from '../src/environment.ts'
import type { EnvironmentSnapshot } from '../src/types.ts'

const snapshot = (overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot => ({
  version: 1,
  collectedAt: '2026-01-01T00:00:00.000Z',
  workspace: 'C:/project',
  writerVersion: '0.1.0',
  platform: 'win32',
  node: 'v22.0.0',
  python: 'Python 3.12.0',
  packageManager: 'pnpm',
  packageManagerVersion: '9.0.0',
  projects: ['node'],
  dependenciesInstalled: { node: true, python: true, rust: true, go: true, unknown: true },
  rust: null,
  go: null,
  lockfiles: ['pnpm-lock.yaml'],
  scripts: ['build', 'test'],
  requiredEnvironmentVariables: ['API_URL'],
  gitBranch: 'main',
  gitCommit: 'abc123',
  ...overrides,
})

describe('checkSnapshot', () => {
  it('reports missing dependencies and missing package-manager executable', async () => {
    const findings = await checkSnapshot('C:/missing-workspace', snapshot({
      packageManagerVersion: null,
      dependenciesInstalled: { node: false, python: true, rust: true, go: true, unknown: true },
      scripts: [],
    }))
    expect(findings.map(finding => finding.field)).toEqual(['dependencies:node', 'env:API_URL', 'packageManager', 'scripts'])
  })

  it('explains an ordinary folder without a supported project manifest', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-workspace-drift-empty-'))
    try {
      const findings = await checkSnapshot(workspace, await collectSnapshot(workspace))
      expect(findings).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'project', severity: 'warning' })]))
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('reports a required variable that is absent or empty without exposing local values', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-workspace-drift-env-'))
    const secret = 'sk-local-secret-must-not-appear'
    try {
      await writeFile(join(workspace, '.env'), `PRESENT=${secret}\nEMPTY=\n`, 'utf8')
      const findings = await checkSnapshot(workspace, snapshot({ requiredEnvironmentVariables: ['MISSING', 'PRESENT', 'EMPTY'] }))
      const text = JSON.stringify(findings)
      expect(findings.map(finding => finding.field)).toContain('env:EMPTY')
      expect(findings.map(finding => finding.field)).toContain('env:MISSING')
      expect(findings.map(finding => finding.field)).not.toContain('env:PRESENT')
      expect(text).not.toContain(secret)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('readBaseline', () => {
  it('rejects malformed stored JSON instead of treating it as a matching baseline', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-workspace-drift-baseline-'))
    try {
      const file = baselinePath(workspace)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, '{', 'utf8')
      await expect(readBaseline(workspace)).rejects.toThrow(/missing|malformed|unsupported/i)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('explains when no baseline has been recorded', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-workspace-drift-no-baseline-'))
    try {
      await expect(readBaseline(workspace)).rejects.toThrow(/No baseline was found/i)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('compareSnapshots', () => {
  it('returns no findings for matching snapshots', () => expect(compareSnapshots(snapshot(), snapshot())).toEqual([]))
  it('reports actionable version and package-manager differences', () => {
    const findings = compareSnapshots(snapshot(), snapshot({ node: 'v18.0.0', packageManager: 'npm' }))
    expect(findings.map(finding => finding.field)).toEqual(['node', 'packageManager'])
  })

  it('reports dependencies that were installed in the baseline but are absent now', () => {
    const findings = compareSnapshots(snapshot(), snapshot({ dependenciesInstalled: { node: false, python: true, rust: true, go: true, unknown: true } }))
    expect(findings.map(finding => finding.field)).toContain('dependencies:node')
  })
})

describe('project detection', () => {
  it('detects Python, Rust, and Go project markers with their dependency state', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-workspace-drift-projects-'))
    try {
      await writeFile(join(workspace, 'pyproject.toml'), '[project]\nname = "sample"\n', 'utf8')
      await writeFile(join(workspace, 'Cargo.toml'), '[package]\nname = "sample"\nversion = "0.1.0"\n', 'utf8')
      await writeFile(join(workspace, 'go.mod'), 'module example.test/sample\n\ngo 1.24\n', 'utf8')
      await writeFile(join(workspace, 'go.sum'), 'example.test/module v1.0.0 h1:checksum\n', 'utf8')
      const current = await collectSnapshot(workspace)
      expect(current.projects).toEqual(['python', 'rust', 'go'])
      expect(current.dependenciesInstalled).toMatchObject({ python: false, rust: false, go: true })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('environment_snapshot storage', () => {
  it('creates a baseline without copying .env secret values', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-workspace-drift-'))
    const secret = 'sk-test-secret-value-must-not-appear'
    try {
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { dev: 'node app.js' } }), 'utf8')
      await writeFile(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8')
      await writeFile(join(workspace, '.env.example'), 'API_URL=\nAPI_TOKEN=\n', 'utf8')
      await writeFile(join(workspace, '.env'), `API_URL=https://private.example\nAPI_TOKEN=${secret}\n`, 'utf8')

      const saved = await writeBaseline(workspace, await collectSnapshot(workspace))
      const baseline = await readFile(saved, 'utf8')

      expect(saved).toBe(join(workspace, '.dsh', 'environment-baseline.json'))
      expect(baseline).toContain('API_URL')
      expect(baseline).toContain('API_TOKEN')
      expect(baseline).not.toContain(secret)
      expect(baseline).not.toContain('https://private.example')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('environment_snapshot tool', () => {
  it('creates a secret-free baseline through the Harness tool registry', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-workspace-drift-tool-'))
    const secret = 'sk-registry-secret-must-not-appear'
    const ctx = new Context()
    try {
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { dev: 'node app.js' } }), 'utf8')
      await writeFile(join(workspace, '.env.example'), 'API_TOKEN=\n', 'utf8')
      await writeFile(join(workspace, '.env'), `API_TOKEN=${secret}\n`, 'utf8')
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(workspaceDrift)

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('workspace-drift-snapshot'),
        name: 'environment_snapshot',
        arguments: { workspace },
      })
      const baseline = await readFile(join(workspace, '.dsh', 'environment-baseline.json'), 'utf8')

      expect(result.isError).toBe(false)
      expect(baseline).toContain('API_TOKEN')
      expect(baseline).not.toContain(secret)
    } finally {
      await ctx.fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    }
  })
})

describe('environment_check tool', () => {
  it('reports a missing required name through the Harness tool registry without exposing a configured secret', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-workspace-drift-check-tool-'))
    const secret = 'sk-check-tool-secret-must-not-appear'
    const ctx = new Context()
    try {
      await writeFile(join(workspace, 'package.json'), JSON.stringify({ scripts: { dev: 'node app.js' } }), 'utf8')
      await writeFile(join(workspace, '.env.example'), 'PRESENT=\nMISSING=\n', 'utf8')
      await writeFile(join(workspace, '.env'), `PRESENT=${secret}\n`, 'utf8')
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(workspaceDrift)

      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId('workspace-drift-check'),
        name: 'environment_check',
        arguments: { workspace },
      })
      const text = JSON.stringify(result)

      expect(result.isError).toBe(false)
      expect(text).toContain('env:MISSING')
      expect(text).not.toContain('env:PRESENT')
      expect(text).not.toContain(secret)
    } finally {
      await ctx.fiber.dispose()
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
