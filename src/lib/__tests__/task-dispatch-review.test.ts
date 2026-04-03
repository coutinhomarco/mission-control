import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockRunOpenClaw,
  mockCallOpenClawGateway,
  mockSpawnAcpSession,
  mockCloseAcpSession,
  mockSubmitPullRequestReview,
  mockCreateIssueComment,
  mockFetchPullRequest,
  mockFetchAuthenticatedUser,
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
  const mockSpawnAcpSession = vi.fn()
  const mockCloseAcpSession = vi.fn()
  const mockSubmitPullRequestReview = vi.fn()
  const mockCreateIssueComment = vi.fn()
  const mockFetchPullRequest = vi.fn()
  const mockFetchAuthenticatedUser = vi.fn()
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
    mockSpawnAcpSession,
    mockCloseAcpSession,
    mockSubmitPullRequestReview,
    mockCreateIssueComment,
    mockFetchPullRequest,
    mockFetchAuthenticatedUser,
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
  submitPullRequestReview: mockSubmitPullRequestReview,
  createIssueComment: mockCreateIssueComment,
  fetchPullRequest: mockFetchPullRequest,
  fetchAuthenticatedUser: mockFetchAuthenticatedUser,
}))

import { runAegisReviews } from '@/lib/task-dispatch'

describe('runAegisReviews', () => {
  beforeEach(() => {
    taskRows.length = 0
    runCalls.length = 0
    vi.clearAllMocks()
    mockFetchPullRequest.mockResolvedValue({ user: { login: 'review-bot' } })
    mockFetchAuthenticatedUser.mockResolvedValue({ login: 'mission-control' })
    mockSpawnAcpSession.mockResolvedValue({ sessionId: 'mc-task-rework', spawnId: 'spawn-1' })
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

  it('requests changes, returns task to in_progress, and spawns a fresh developer session', async () => {
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
    mockSpawnAcpSession.mockResolvedValue({ sessionId: 'mc-task-9-rework', spawnId: 'spawn-9' })

    const result = await runAegisReviews()

    expect(result.ok).toBe(true)
    expect(mockSubmitPullRequestReview).toHaveBeenCalledWith('acme/app', 96, expect.objectContaining({
      event: 'REQUEST_CHANGES',
    }))
    expect(mockSubmitPullRequestReview).toHaveBeenCalledWith('acme/app', 96, expect.objectContaining({
      body: expect.stringContaining('Reason:\nFix the hover state'),
    }))
    expect(mockCloseAcpSession).toHaveBeenCalledWith('mc-task-9', '/root/things/profitstack-next')
    expect(mockSpawnAcpSession).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      cwd: '/root/things/profitstack-next',
      label: 'mc-task-9-rework',
      task: expect.stringContaining('Do not open a new PR'),
    }))
    expect(runCalls.some((call) => call.sql.includes('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, metadata = ?, updated_at = ? WHERE id = ?') && call.args[0] === 'in_progress')).toBe(true)
  })

  it('fails permanently when a review task has no pr_url metadata', async () => {
    taskRows.push({
      id: 11,
      title: 'Broken review state',
      description: 'Task was moved manually',
      resolution: 'Done',
      assigned_to: 'codex',
      agent_config: null,
      workspace_id: 1,
      ticket_prefix: null,
      project_ticket_no: null,
      metadata: JSON.stringify({}),
      github_repo: null,
      dispatch_attempts: 0,
    })

    const result = await runAegisReviews()

    expect(result.ok).toBe(false)
    expect(runCalls.some((call) => call.sql.includes('UPDATE tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?') && call.args[0] === 'failed')).toBe(true)
    expect(mockBroadcast).toHaveBeenCalledWith('task.status_changed', expect.objectContaining({
      id: 11,
      status: 'failed',
      previous_status: 'quality_review',
      reason: 'invalid_review_state',
    }))
  })

  it('falls back to a regular PR comment when the token owner authored the PR', async () => {
    taskRows.push({
      id: 12,
      title: 'Self-authored PR',
      description: 'Needs another pass',
      resolution: 'Done',
      assigned_to: 'codex',
      agent_config: null,
      workspace_id: 1,
      ticket_prefix: null,
      project_ticket_no: null,
      metadata: JSON.stringify({ pr_url: 'https://github.com/acme/app/pull/108', dispatch_session_id: 'mc-task-12' }),
      github_repo: 'acme/app',
      dispatch_attempts: 1,
    })
    mockRunOpenClaw.mockResolvedValue({
      stdout: 'VERDICT: REJECTED\nNOTES: Fix the failing test',
      stderr: '',
      code: 0,
    })
    mockSpawnAcpSession.mockResolvedValue({ sessionId: 'mc-task-12-rework', spawnId: 'spawn-12' })
    mockFetchPullRequest.mockResolvedValue({ user: { login: 'coutinhomarco' } })
    mockFetchAuthenticatedUser.mockResolvedValue({ login: 'coutinhomarco' })

    const result = await runAegisReviews()

    expect(result.ok).toBe(true)
    expect(mockSubmitPullRequestReview).not.toHaveBeenCalled()
    expect(mockCreateIssueComment).toHaveBeenCalledWith(
      'acme/app',
      108,
      expect.stringContaining('Reason:\nFix the failing test'),
    )
    expect(mockCloseAcpSession).toHaveBeenCalledWith('mc-task-12', '/root/things/profitstack-next')
    expect(mockSpawnAcpSession).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'codex',
      label: 'mc-task-12-rework',
    }))
  })

  it('keeps rejected tasks in_progress even after many Aegis retries', async () => {
    taskRows.push({
      id: 13,
      title: 'Retryable review task',
      description: 'Needs another pass',
      resolution: 'Done',
      assigned_to: 'codex',
      agent_config: null,
      workspace_id: 1,
      ticket_prefix: null,
      project_ticket_no: null,
      metadata: JSON.stringify({ pr_url: 'https://github.com/acme/app/pull/109', dispatch_session_id: 'mc-task-13' }),
      github_repo: 'acme/app',
      dispatch_attempts: 6,
    })
    mockRunOpenClaw.mockResolvedValue({
      stdout: 'VERDICT: REJECTED\nNOTES: Missing persistence for fnsku\nNeed coverage for the new parser',
      stderr: '',
      code: 0,
    })
    mockSpawnAcpSession.mockResolvedValue({ sessionId: 'mc-task-13-rework', spawnId: 'spawn-13' })

    const result = await runAegisReviews()

    expect(result.ok).toBe(true)
    expect(runCalls.some((call) => call.sql.includes('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, metadata = ?, updated_at = ? WHERE id = ?') && call.args[0] === 'in_progress')).toBe(true)
    expect(runCalls.some((call) => call.sql.includes('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?') && call.args[0] === 'failed')).toBe(false)
    expect(mockBroadcast).toHaveBeenCalledWith('task.status_changed', expect.objectContaining({
      id: 13,
      status: 'in_progress',
      reason: 'aegis_rejection',
    }))
    expect(mockSubmitPullRequestReview).toHaveBeenCalledWith('acme/app', 109, expect.objectContaining({
      body: expect.stringContaining('Missing persistence for fnsku\nNeed coverage for the new parser'),
    }))
  })

  it('spawns a new developer session when a rejected task has no reusable session', async () => {
    taskRows.push({
      id: 16,
      title: 'Retry from fresh session',
      description: 'Needs rework',
      resolution: 'Done',
      assigned_to: 'claude',
      agent_config: JSON.stringify({ openclawId: 'claude-code-dev' }),
      workspace_id: 1,
      ticket_prefix: null,
      project_ticket_no: null,
      metadata: JSON.stringify({ pr_url: 'https://github.com/acme/app/pull/110', pr_file: '/tmp/mc-task-16.pr' }),
      github_repo: 'acme/app',
      dispatch_attempts: 2,
    })
    mockRunOpenClaw.mockResolvedValue({
      stdout: 'VERDICT: REJECTED\nNOTES: Fix the parser edge case',
      stderr: '',
      code: 0,
    })
    mockSpawnAcpSession.mockResolvedValue({ sessionId: 'mc-task-16-rework', spawnId: 'spawn-16' })

    const result = await runAegisReviews()

    expect(result.ok).toBe(true)
    expect(mockCloseAcpSession).not.toHaveBeenCalled()
    expect(mockSpawnAcpSession).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'claude-code-dev',
      cwd: '/root/things/profitstack-next',
      label: 'mc-task-16-rework',
      taskId: 16,
      task: expect.stringContaining('Fix the parser edge case'),
    }))
    expect(runCalls.some((call) => call.sql.includes('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, metadata = ?, updated_at = ? WHERE id = ?') && call.args[0] === 'in_progress')).toBe(true)
  })
})
