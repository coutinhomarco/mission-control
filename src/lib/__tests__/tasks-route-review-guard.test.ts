import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRoleMock = vi.fn(() => ({ user: { username: 'tester', workspace_id: 1, role: 'operator' } }))
const mutationLimiterMock = vi.fn(() => null)
const validateBodyMock = vi.fn()
const normalizeTaskUpdateStatusMock = vi.fn((args: { requestedStatus?: string }) => args.requestedStatus)
const prepareMock = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mutationLimiterMock }))
vi.mock('@/lib/validation', () => ({
  validateBody: validateBodyMock,
  updateTaskSchema: {},
}))
vi.mock('@/lib/task-status', () => ({ normalizeTaskUpdateStatus: normalizeTaskUpdateStatusMock }))
vi.mock('@/lib/mentions', () => ({ resolveMentionRecipients: vi.fn(() => ({ recipients: [], unresolved: [] })) }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: vi.fn() } }))
vi.mock('@/lib/github-sync-engine', () => ({ pushTaskToGitHub: vi.fn() }))
vi.mock('@/lib/gnap-sync', () => ({ pushTaskToGnap: vi.fn(), removeTaskFromGnap: vi.fn() }))
vi.mock('@/lib/config', () => ({ config: { gnap: { enabled: false, autoSync: false, repoPath: '' } } }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

const currentTask = {
  id: 11,
  workspace_id: 1,
  title: 'Task title',
  description: 'desc',
  status: 'failed',
  priority: 'medium',
  project_id: 1,
  assigned_to: 'claude',
  tags: '[]',
  metadata: '{}',
  resolution: null,
  created_at: 1000,
  updated_at: 1000,
}

const getMock = vi.fn((...args: any[]) => {
  if (args[0] === 11 && args[1] === 1) return currentTask
  return undefined
})

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({
    prepare: prepareMock,
  })),
  db_helpers: {
    createNotification: vi.fn(),
    ensureTaskSubscription: vi.fn(),
    logActivity: vi.fn(),
  },
}))

describe('PUT /api/tasks/[id] review guards', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    prepareMock.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?')) {
        return { get: getMock }
      }
      throw new Error(`Unexpected SQL in test: ${sql}`)
    })
  })

  it('rejects moving a task to review without metadata.pr_url', async () => {
    validateBodyMock.mockResolvedValue({
      data: {
        status: 'review',
        resolution: 'Implemented it',
      },
    })

    const { PUT } = await import('@/app/api/tasks/[id]/route')
    const request = new NextRequest('http://localhost/api/tasks/11', {
      method: 'PUT',
      body: JSON.stringify({ status: 'review', resolution: 'Implemented it' }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await PUT(request, { params: Promise.resolve({ id: '11' }) })
    const payload = await response.json() as { error?: string }

    expect(response.status).toBe(400)
    expect(payload.error).toBe('A PR URL in task metadata is required to move a task to review.')
  })

  it('rejects moving a task to review without resolution', async () => {
    validateBodyMock.mockResolvedValue({
      data: {
        status: 'review',
        metadata: { pr_url: 'https://github.com/acme/app/pull/96' },
      },
    })

    const { PUT } = await import('@/app/api/tasks/[id]/route')
    const request = new NextRequest('http://localhost/api/tasks/11', {
      method: 'PUT',
      body: JSON.stringify({ status: 'review', metadata: { pr_url: 'https://github.com/acme/app/pull/96' } }),
      headers: { 'content-type': 'application/json' },
    })

    const response = await PUT(request, { params: Promise.resolve({ id: '11' }) })
    const payload = await response.json() as { error?: string }

    expect(response.status).toBe(400)
    expect(payload.error).toBe('A resolution is required to move a task to review.')
  })
})
