import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { checkSnapshot, collectSnapshot, compareSnapshots, readBaseline, sortFindings, writeBaseline } from './environment.js'

export const name = 'dsh-workspace-drift'
export const inject = ['tools']

const workspaceParameter = {
  workspace: { type: 'string' as const, required: true as const, description: 'Absolute path to the project workspace.' },
} as const

const output = {
  schema: { type: 'object' as const, additionalProperties: true as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

function summary(findings: readonly unknown[], noun: string): string {
  return findings.length === 0 ? 'No critical environment differences were found.' : `${findings.length} ${noun} found.`
}

/** Register the initial environment snapshot, check, and compare tools. */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'environment_snapshot',
    description: 'Record the current project environment without saving secret values.',
    parameters: workspaceParameter,
    output,
    async execute(args, exec) {
      const snapshot = await collectSnapshot(args.workspace, exec.signal)
      const file = await writeBaseline(args.workspace, snapshot)
      return { file, snapshot }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'environment_check',
    description: 'Inspect the current project environment and report basic runnable prerequisites.',
    parameters: workspaceParameter,
    output,
    async execute(args, exec) {
      const snapshot = await collectSnapshot(args.workspace, exec.signal)
      const findings = await checkSnapshot(args.workspace, snapshot)
      return { snapshot, findings, summary: summary(findings, 'environment issue(s)') }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'environment_compare',
    description: 'Compare the saved project environment with the current machine and explain differences.',
    parameters: workspaceParameter,
    output,
    async execute(args, exec) {
      const expected = await readBaseline(args.workspace)
      const actual = await collectSnapshot(args.workspace, exec.signal)
      const findings = sortFindings([...compareSnapshots(expected, actual), ...await checkSnapshot(args.workspace, actual)])
      return { expected, actual, findings, summary: summary(findings, 'environment difference(s)') }
    },
  }))
}
