import type { JsonValue } from '@deepseek-ai/dsh-session'

export type ProjectKind = 'node' | 'python' | 'rust' | 'go' | 'unknown'

/** A JSON-safe project environment baseline. Secret values are never included. */
export interface EnvironmentSnapshot extends Record<string, JsonValue> {
  version: 1
  collectedAt: string
  workspace: string
  writerVersion: string
  platform: NodeJS.Platform
  node: string
  python: string | null
  packageManager: string | null
  packageManagerVersion: string | null
  projects: ProjectKind[]
  dependenciesInstalled: Record<ProjectKind, boolean>
  rust: string | null
  go: string | null
  lockfiles: string[]
  scripts: string[]
  requiredEnvironmentVariables: string[]
  gitBranch: string | null
  gitCommit: string | null
}

export type FindingSeverity = 'error' | 'warning' | 'info'

export interface Finding extends Record<string, JsonValue> {
  severity: FindingSeverity
  field: string
  message: string
  advice: string
}

/** Structured result returned by environment inspection and comparison tools. */
export interface EnvironmentReport extends Record<string, JsonValue> {
  snapshot: EnvironmentSnapshot
  findings: Finding[]
  summary: string
}
