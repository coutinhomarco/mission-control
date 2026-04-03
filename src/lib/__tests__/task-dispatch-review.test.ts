import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRunOpenClaw,
  mockCallOpenClawGateway,
  mockSubmitPullRequestReview,
  mockBroadcast,
  mockLogActivity,
  mockPrepare,
  runCalls,
  taskRows,
} = vi.hoisted(() => {
  const runCalls: Array<{ sql: string; args: unknown[] }> = []
  const taskRows: any[] = []
  const mockRunOpenClaw = vi.fn()
  const mockCallOpenClawGateway = vi.fn()
  const mockSubmitPullRequestReview = vi.fn()
  const mockBroadcast = vi.fn()
  const mockLogActivity = vi.fn()
  const mockPrepare = vi.fn((sql: string) => ({
    all: vi.fn(() => sql.includes('FROM tasks t') ? taskRows : []),
    get: vi.fn(() => undefined),
    run: vi.fn((...args: unknown[]) => {
      runCalls.push({ sql, args })
      return { changes: 1, lastInsertRowid: 1 }
    }),
  }))
  return {
    mockRunOpenClaw,
    mockCallOpenClawGateway,
    mockSubmitPullRequestReview,
    mockBroadcast,
    mockLogActivity,
    mockPrepare,
    runCalls,
    taskRows,
  }
})

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: mockPrepare })),
  db_helpers: { logActivity: mockLogActivity },
}))

vi.mock('@/lib/command', () => ({
  runCommand: vi.fn(),
  runOpenClaw: mockRunOpenClaw,
}))

vi.mock('@/lib/openclaw-gateway', () => ({
  callOpenClawGateway: mockCallOpenClawGateway,
  spawnAcpSession: vi.fn(),
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
  submitPullRequestReview: mockSubmitPullRequestReview,
}))

import { runAegisReviews } from '@/lib/task-dispatch'

describe('runAegisReviews', () => {
  beforeEach(() => {
    taskRows.length = 0
    runCalls.length = 0
    vi.clearAllMocks()
  })

  it('approves the PR, comments on the task, and moves it to done', async () => {
    taskRows.push({
      id: 9,
      title: 'Fix login button',
      description: 'Make it green',
      resolution: 'Implemented the change.',
      assigned_to: 'codex',
      agent_config: null,
      workspace_id: 1,
      ticket_prefix: null,
      project_ticket_no: null,
      metadata: JSON.stringify({ pr_url: 'https://github.com/acme/app/pull/96', dispatch_session_id: 'mc-task-9' }),
      github_repo: 'acme/app',
      dispatch_attempts: 0,
    })
    mockRunOpenClaw.mockResolvedValue({
      stdout: 'VERDICT: APPROVED\nNOTES: Looks good',
      stderr: '',
      code: 0,
    })

    const result = await runAegisReviews()

    expect(result.ok).toBe(true)
    expect(mockSubmitPullRequestReview).toHaveBeenCalledWith('acme/app', 96, expect.objectContaining({
      event: 'APPROVE',
    }))
    expect(runCalls.some((call) => call.sql.includes('INSERT INTO comments') && String(call.args[1]).includes('Aegis Review: APPROVED'))).toBe(true)
    expect(runCalls.some((call) => call.sql.includes('UPDATE tasks SET status = ?, error_message = NULL') && call.args[0] === 'done')).toBe(true)
  })

  it('requests changes, returns task to in_progress, and recontacts the same session', async () => {
    taskRows.push({
      id: 9,
      title: 'Fix login button',
      description: 'Make it green',
      resolution: 'Implemented the change.',
      assigned_to: 'codex',
      agent_config: null,
      workspace_id: 1,
      ticket_prefix: null,
      project_ticket_no: null,
      metadata: JSON.stringify({ pr_url: 'https://github.com/acme/app/pull/96', dispatch_session_id: 'mc-task-9' }),
      github_repo: 'acme/app',
      dispatch_attempts: 1,
    })
    mockRunOpenClaw.mockResolvedValue({
      stdout: 'VERDICT: REJECTED\nNOTES: Fix the hover state',
      stderr: '',
      code: 0,
    })
    mockCallOpenClawGateway.mockResolvedValue({ status: 'ok' })

    const result = await runAegisReviews()

    expect(result.ok).toBe(true)
    expect(mockSubmitPullRequestReview).toHaveBeenCalledWith('acme/app', 96, expect.objectContaining({
      event: 'REQUEST_CHANGES',
    }))
    expect(mockCallOpenClawGateway).toHaveBeenCalledWith('chat.send', expect.objectContaining({
      sessionKey: 'mc-task-9',
      message: expect.stringContaining('Do not open a new PR'),
    }), 125000)
    expect(runCalls.some((call) => call.sql.includes('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, metadata = ?, updated_at = ? WHERE id = ?') && call.args[0] === 'in_progress')).toBe(true)
  })
})
