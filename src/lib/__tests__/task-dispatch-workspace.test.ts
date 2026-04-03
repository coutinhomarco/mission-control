import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runCommand } = vi.hoisted(() => ({
  runCommand: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: vi.fn() })),
  db_helpers: { logActivity: vi.fn(), createNotification: vi.fn() },
}))

vi.mock('@/lib/command', () => ({
  runCommand,
  runOpenClaw: vi.fn(),
}))

vi.mock('@/lib/openclaw-gateway', () => ({
  callOpenClawGateway: vi.fn(),
  spawnAcpSession: vi.fn(),
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn() },
}))

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

vi.mock('@/lib/config', () => ({
  config: { openclawHome: '/root/.openclaw' },
}))

vi.mock('@/lib/github', () => ({
  submitPullRequestReview: vi.fn(),
}))

import { prepareWorkspaceForTask } from '@/lib/task-dispatch'

describe('prepareWorkspaceForTask', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 })
  })

  it('force-resets and cleans the workspace before and after syncing the base branch', async () => {
    await prepareWorkspaceForTask('/tmp/workspace', 'dev')

    expect(runCommand.mock.calls).toEqual([
      ['git', ['reset', '--hard', 'HEAD'], { cwd: '/tmp/workspace', timeoutMs: 10000 }],
      ['git', ['clean', '-fd', '-e', '.openclaw'], { cwd: '/tmp/workspace', timeoutMs: 10000 }],
      ['git', ['fetch', 'origin', 'dev'], { cwd: '/tmp/workspace', timeoutMs: 30000 }],
      ['git', ['checkout', 'dev'], { cwd: '/tmp/workspace', timeoutMs: 15000 }],
      ['git', ['pull', '--ff-only', 'origin', 'dev'], { cwd: '/tmp/workspace', timeoutMs: 30000 }],
      ['git', ['reset', '--hard', 'origin/dev'], { cwd: '/tmp/workspace', timeoutMs: 15000 }],
      ['git', ['clean', '-fd', '-e', '.openclaw'], { cwd: '/tmp/workspace', timeoutMs: 10000 }],
    ])
  })

  it('creates a tracking branch when the base branch does not exist locally', async () => {
    runCommand.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'checkout' && args[1] === 'dev') {
        throw new Error('missing local branch')
      }
      return { stdout: '', stderr: '', code: 0 }
    })

    await prepareWorkspaceForTask('/tmp/workspace', 'dev')

    expect(runCommand).toHaveBeenCalledWith(
      'git',
      ['checkout', '-b', 'dev', '--track', 'origin/dev'],
      { cwd: '/tmp/workspace', timeoutMs: 15000 },
    )
  })
})
