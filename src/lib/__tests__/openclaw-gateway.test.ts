import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runCommand } = vi.hoisted(() => ({
  runCommand: vi.fn(),
}))

vi.mock('@/lib/command', () => ({
  runOpenClaw: vi.fn(),
  runCommand,
}))

import { parseGatewayJsonOutput, spawnAcpSession } from '@/lib/openclaw-gateway'

describe('parseGatewayJsonOutput', () => {
  beforeEach(() => {
    runCommand.mockReset()
  })

  it('parses embedded object payloads', () => {
    expect(parseGatewayJsonOutput('warn\n{"status":"started","runId":"abc"}\n')).toEqual({
      status: 'started',
      runId: 'abc',
    })
  })

  it('parses embedded array payloads', () => {
    expect(parseGatewayJsonOutput('note\n[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('returns null for non-json output', () => {
    expect(parseGatewayJsonOutput('plain text only')).toBeNull()
  })

  it('uses the requested agent and model when spawning acpx sessions', async () => {
    runCommand
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: '', code: 4 })

    await spawnAcpSession({
      task: 'fix it',
      agentId: 'claude',
      model: 'claude-opus-4-6',
      label: 'mc-task-42',
      cwd: '/tmp/workspace',
      taskId: 42,
    })

    expect(runCommand).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      ['--approve-all', 'claude', 'sessions', 'new', '--name', 'mc-task-42'],
      expect.objectContaining({ cwd: '/tmp/workspace', timeoutMs: 30000 })
    )

    expect(runCommand).toHaveBeenNthCalledWith(
      2,
      expect.any(String),
      ['--approve-all', 'claude', 'set-mode', '--session', 'mc-task-42', 'auto'],
      expect.objectContaining({ cwd: '/tmp/workspace', timeoutMs: 30000 })
    )

    expect(runCommand).toHaveBeenNthCalledWith(
      3,
      expect.any(String),
      [
        '--approve-all',
        '--model',
        'claude-opus-4-6',
        'claude',
        '--no-wait',
        '--session',
        'mc-task-42',
        expect.stringContaining('IMPORTANT: When you have created the Pull Request'),
      ],
      expect.objectContaining({ allowExitCodes: [4], cwd: '/tmp/workspace', timeoutMs: 30000 })
    )
  })
})
