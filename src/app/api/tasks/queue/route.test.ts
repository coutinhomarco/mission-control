import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRoleMock = vi.fn(() => ({ user: { username: 'tester', workspace_id: 1, role: 'operator' } }))
const agentTaskLimiterMock = vi.fn(() => null)
const loggerErrorMock = vi.fn()
const broadcastMock = vi.fn()
const getCurrentTaskMock = vi.fn(() => undefined)
const getInProgressCountMock = vi.fn(() => ({ c: 0 }))
const claimTaskMock = vi.fn()
const prepareMock = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole: requireRoleMock }))
vi.mock('@/lib/rate-limit', () => ({ agentTaskLimiter: agentTaskLimiterMock }))
vi.mock('@/lib/logger', () => ({ logger: { error: loggerErrorMock } }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: broadcastMock } }))
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: prepareMock })),
}))

describe('GET /api/tasks/queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    claimTaskMock.mockReturnValue({
      id: 42,
      title: 'Claimed task',
      status: 'assigned',
      assigned_to: 'claude',
      tags: '[]',
      metadata: '{}',
    })

    prepareMock.mockImplementation((sql: string) => {
      if (sql.includes("WHERE workspace_id = ? AND assigned_to = ? AND status = 'in_progress'") && sql.includes('LIMIT 1')) {
        return { get: getCurrentTaskMock }
      }
      if (sql.includes("SELECT COUNT(*) as c") && sql.includes("status = 'in_progress'")) {
        return { get: getInProgressCountMock }
      }
      if (sql.includes("UPDATE tasks") && sql.includes("SET status = 'in_progress'")) {
        return { get: claimTaskMock }
      }
      throw new Error(`Unexpected SQL in test: ${sql}`)
    })
  })

  it('broadcasts an in_progress status change when an agent claims a task', async () => {
    const { GET } = await import('./route')
    const request = new NextRequest('http://localhost/api/tasks/queue?agent=claude')

    const response = await GET(request)
    const payload = await response.json() as { task?: { id: number; status: string } }

    expect(response.status).toBe(200)
    expect(payload.task?.id).toBe(42)
    expect(payload.task?.status).toBe('assigned')
    expect(broadcastMock).toHaveBeenCalledWith('task.status_changed', expect.objectContaining({
      id: 42,
      status: 'in_progress',
      previous_status: 'assigned',
      assigned_to: 'claude',
    }))
  })
})
