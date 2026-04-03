import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

const {
  allMock,
  runMock,
  prepareMock,
  broadcastMock,
  closeAcpSessionMock,
  runOpenClawMock,
} = vi.hoisted(() => ({
  allMock: vi.fn(),
  runMock: vi.fn(),
  prepareMock: vi.fn(),
  broadcastMock: vi.fn(),
  closeAcpSessionMock: vi.fn(),
  runOpenClawMock: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ prepare: prepareMock })),
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: broadcastMock } }))
vi.mock('@/lib/openclaw-gateway', () => ({ closeAcpSession: closeAcpSessionMock }))
vi.mock('@/lib/agent-sync', () => ({ syncAgentsFromConfig: vi.fn() }))
vi.mock('@/lib/config', () => ({
  config: {
    dbPath: '/tmp/mission-control-test.db',
    tokensPath: '/tmp/mission-control-token-usage.json',
    retention: {
      activities: 90,
      auditLog: 365,
      notifications: 60,
      pipelineRuns: 90,
      tokenUsage: 0,
      claudeSessions: 30,
      gatewaySessions: 90,
    },
  },
  ensureDirExists: vi.fn(),
}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }))
vi.mock('@/lib/webhooks', () => ({ processWebhookRetries: vi.fn() }))
vi.mock('@/lib/claude-sessions', () => ({ syncClaudeSessions: vi.fn() }))
vi.mock('@/lib/sessions', () => ({ pruneGatewaySessionsOlderThan: vi.fn(), getAgentLiveStatuses: vi.fn() }))
vi.mock('@/lib/skill-sync', () => ({ syncSkillsFromDisk: vi.fn() }))
vi.mock('@/lib/local-agent-sync', () => ({ syncLocalAgents: vi.fn() }))
vi.mock('@/lib/command', () => ({ runOpenClaw: runOpenClawMock }))
vi.mock('@/lib/task-dispatch', () => ({
  dispatchAssignedTasks: vi.fn(),
  runAegisReviews: vi.fn(),
  requeueStaleTasks: vi.fn(),
  autoRouteInboxTasks: vi.fn(),
}))
vi.mock('@/lib/recurring-tasks', () => ({ spawnRecurringTasks: vi.fn() }))

import { checkPrFiles, extractFinalAgentMessageFromAcpStream, triggerTask } from '@/lib/scheduler'

describe('extractFinalAgentMessageFromAcpStream', () => {
  it('returns the final completed assistant turn from an ACP stream', () => {
    const stream = [
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"primeira"}}}}',
      '{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"segunda "}}}}',
      '{"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"final"}}}}',
      '{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}',
    ].join('\n')

    expect(extractFinalAgentMessageFromAcpStream(stream)).toBe('segunda final')
  })

  it('ignores malformed lines and returns null when no assistant text exists', () => {
    expect(extractFinalAgentMessageFromAcpStream('not-json\n{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}')).toBeNull()
  })
})

describe('checkPrFiles', () => {
  const tmpDir = '/tmp/mission-control-scheduler-test'
  const prFile = join(tmpDir, 'mc-task-12.pr')

  beforeEach(() => {
    vi.clearAllMocks()
    rmSync(tmpDir, { recursive: true, force: true })
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(prFile, 'https://github.com/acme/app/pull/109\n')

    allMock.mockReturnValue([
      {
        id: 12,
        title: 'Async PR task',
        metadata: JSON.stringify({
          pr_file: prFile,
          dispatch_session_id: 'mc-task-12',
          workspace: '/root/things/profitstack-next',
        }),
      },
    ])

    prepareMock.mockImplementation((sql: string) => {
      if (sql.includes('FROM tasks') && sql.includes("WHERE status = 'in_progress'")) {
        return { all: allMock }
      }
      if (sql.includes('UPDATE tasks SET status = ?, outcome = ?, resolution = ?, metadata = ?, updated_at = ? WHERE id = ?')) {
        return { run: runMock }
      }
      throw new Error(`Unexpected SQL in test: ${sql}`)
    })
  })

  it('broadcasts review when a PR file promotes an in_progress task', async () => {
    const result = await checkPrFiles()

    expect(result.ok).toBe(true)
    expect(runMock).toHaveBeenCalledOnce()
    expect(broadcastMock).toHaveBeenCalledWith('task.status_changed', expect.objectContaining({
      id: 12,
      status: 'review',
      previous_status: 'in_progress',
    }))
    expect(closeAcpSessionMock).toHaveBeenCalledWith('mc-task-12', '/root/things/profitstack-next')
  })
})

describe('auto_cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runOpenClawMock.mockResolvedValue({
      stdout: JSON.stringify({
        stores: [
          { missing: 1, pruned: 2, capped: 0 },
          { missing: 0, pruned: 0, capped: 3 },
        ],
      }),
      stderr: '',
      code: 0,
    })

    prepareMock.mockReturnValue({ run: vi.fn(() => ({ changes: 0 })) })
  })

  it('uses OpenClaw native session cleanup during auto cleanup', async () => {
    const result = await triggerTask('auto_cleanup')

    expect(result.ok).toBe(true)
    expect(runOpenClawMock).toHaveBeenCalledWith(
      ['sessions', 'cleanup', '--all-agents', '--enforce', '--fix-missing', '--json'],
      expect.objectContaining({ timeoutMs: 120000 })
    )
    expect(result.message).toContain('Cleaned 6 stale records')
  })
})
