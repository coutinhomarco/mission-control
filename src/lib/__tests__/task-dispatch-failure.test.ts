import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  runCalls,
  taskRows,
  metadataByTask,
  dispatchAttemptsByTask,
  mockRunCommand,
  mockRunOpenClaw,
  mockCreateNotification,
  mockLogActivity,
  mockBroadcast,
  mockPrepare,
  mockSpawnAcpSession,
  mockCloseAcpSession,
} = vi.hoisted(() => {
  const runCalls: Array<{ sql: string; args: unknown[] }> = []
  const taskRows: any[] = []
  const metadataByTask = new Map<number, string | null>()
  const dispatchAttemptsByTask = new Map<number, number>()
  const mockRunCommand = vi.fn()
  const mockRunOpenClaw = vi.fn()
  const mockCreateNotification = vi.fn()
  const mockLogActivity = vi.fn()
  const mockBroadcast = vi.fn()
  const mockSpawnAcpSession = vi.fn()
  const mockCloseAcpSession = vi.fn()
  const mockPrepare = vi.fn((sql: string) => ({
    all: vi.fn(() => sql.includes('FROM tasks t') ? taskRows : []),
    get: vi.fn((taskId?: number) => {
      if (sql.includes("author = 'aegis'")) return undefined
      if (sql.startsWith('SELECT metadata FROM tasks')) return { metadata: metadataByTask.get(Number(taskId)) ?? null }
      if (sql.startsWith('SELECT dispatch_attempts FROM tasks')) return { dispatch_attempts: dispatchAttemptsByTask.get(Number(taskId)) ?? 0 }
      return undefined
    }),
    run: vi.fn((...args: unknown[]) => {
      runCalls.push({ sql, args })
      return { changes: 1, lastInsertRowid: 1 }
    }),
  }))

  return {
    runCalls,
    taskRows,
    metadataByTask,
    dispatchAttemptsByTask,
    mockRunCommand,
    mockRunOpenClaw,
    mockCreateNotification,
    mockLogActivity,
    mockBroadcast,
    mockPrepare,
    mockSpawnAcpSession,
    mockCloseAcpSession,
  }
})

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: mockPrepare })),
  db_helpers: {
    logActivity: mockLogActivity,
    createNotification: mockCreateNotification,
  },
}))

vi.mock('@/lib/command', () => ({
  runCommand: mockRunCommand,
  runOpenClaw: mockRunOpenClaw,
}))

vi.mock('@/lib/openclaw-gateway', () => ({
  callOpenClawGateway: vi.fn(),
  spawnAcpSession: mockSpawnAcpSession,
  closeAcpSession: mockCloseAcpSession,
}))

vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: mockBroadcast },
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

import { dispatchAssignedTasks } from '@/lib/task-dispatch'

describe('dispatchAssignedTasks failure surfacing', () => {
  beforeEach(() => {
    taskRows.length = 0
    runCalls.length = 0
    metadataByTask.clear()
    dispatchAttemptsByTask.clear()
    vi.clearAllMocks()
  })

  it('creates a notification and task comment when workspace preparation fails', async () => {
    taskRows.push({
      id: 41,
      title: 'Fix broken dispatch',
      description: 'Reproduce the git failure',
      status: 'assigned',
      priority: 'high',
      assigned_to: 'codex',
      workspace_id: 1,
      agent_name: 'codex',
      agent_id: 7,
      agent_config: JSON.stringify({ openclawId: 'codex' }),
      ticket_prefix: null,
      project_ticket_no: null,
      project_id: null,
      github_default_branch: null,
      tags: undefined,
    })
    metadataByTask.set(41, JSON.stringify({ workspace: '/root/things/profitstack-next' }))
    dispatchAttemptsByTask.set(41, 0)

    mockRunCommand.mockImplementation(async (_command: string, args: string[]) => {
      if (args[0] === 'fetch') {
        throw new Error('Command failed (git fetch origin dev): network down')
      }
      return { stdout: '', stderr: '', code: 0 }
    })

    const result = await dispatchAssignedTasks()

    expect(result.ok).toBe(false)
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'codex',
      'dispatch_error',
      'Dispatch failed for [TASK-41] Fix broken dispatch',
      expect.stringContaining('network down'),
      'task',
      41,
      1,
    )
    expect(runCalls.some((call) => call.sql.includes('INSERT INTO comments') && String(call.args[1]).includes('Dispatch error for [TASK-41] Fix broken dispatch'))).toBe(true)
    expect(runCalls.some((call) => call.sql.includes('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?') && call.args[0] === 'assigned')).toBe(true)
    expect(mockBroadcast).toHaveBeenCalledWith('task.updated', expect.objectContaining({
      id: 41,
      status: 'assigned',
      error_message: expect.stringContaining('network down'),
      dispatch_attempts: 1,
    }))
  })

  it('fails the dispatch when synchronous completion returns without a PR URL', async () => {
    taskRows.push({
      id: 42,
      title: 'Inline completion without PR',
      description: 'Agent forgot to open a PR',
      status: 'assigned',
      priority: 'high',
      assigned_to: 'codex',
      workspace_id: 1,
      agent_name: 'codex',
      agent_id: 7,
      agent_config: JSON.stringify({ openclawId: 'codex' }),
      ticket_prefix: null,
      project_ticket_no: null,
      project_id: null,
      github_default_branch: null,
      tags: undefined,
    })
    metadataByTask.set(42, JSON.stringify({ workspace: '/root/things/profitstack-next' }))
    dispatchAttemptsByTask.set(42, 0)

    mockRunCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    mockSpawnAcpSession.mockRejectedValue(new Error('spawn unavailable'))
    mockRunOpenClaw.mockResolvedValue({
      stdout: 'Implemented the change and committed it locally.',
      stderr: '',
      code: 0,
    })

    const result = await dispatchAssignedTasks()

    expect(result.ok).toBe(false)
    expect(runCalls.some((call) =>
      call.sql.includes('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
      && call.args[0] === 'assigned'
      && String(call.args[1]).includes('cannot move to review without a PR URL')
    )).toBe(true)
    expect(mockCreateNotification).toHaveBeenCalledWith(
      'codex',
      'dispatch_error',
      'Dispatch failed for [TASK-42] Inline completion without PR',
      expect.stringContaining('cannot move to review without a PR URL'),
      'task',
      42,
      1,
    )
  })

  it('closes any stale task-linked ACP session before spawning a fresh developer session', async () => {
    taskRows.push({
      id: 43,
      title: 'Fresh dispatch only',
      description: 'Avoid session reuse',
      status: 'assigned',
      priority: 'high',
      assigned_to: 'codex',
      workspace_id: 1,
      agent_name: 'codex',
      agent_id: 7,
      agent_config: JSON.stringify({ openclawId: 'codex' }),
      ticket_prefix: null,
      project_ticket_no: null,
      project_id: null,
      github_default_branch: null,
      tags: undefined,
    })
    metadataByTask.set(43, JSON.stringify({
      workspace: '/root/things/profitstack-next',
      target_session: 'stale-session',
      dispatch_session_id: 'stale-session',
    }))
    dispatchAttemptsByTask.set(43, 0)

    mockRunCommand.mockResolvedValue({ stdout: '', stderr: '', code: 0 })
    mockSpawnAcpSession.mockResolvedValue({ sessionId: 'mc-task-43', spawnId: 'spawn-43' })

    const result = await dispatchAssignedTasks()

    expect(result.ok).toBe(true)
    expect(mockCloseAcpSession).toHaveBeenCalledWith('stale-session', '/root/things/profitstack-next')
    expect(mockSpawnAcpSession).toHaveBeenCalledWith(expect.objectContaining({
      label: 'mc-task-43',
      cwd: '/root/things/profitstack-next',
    }))
  })
})
