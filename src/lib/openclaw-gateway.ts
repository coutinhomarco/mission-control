import { runOpenClaw, runCommand } from './command'
import { randomUUID } from 'node:crypto'

export function parseGatewayJsonOutput(raw: string): unknown | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null

  const objectStart = trimmed.indexOf('{')
  const arrayStart = trimmed.indexOf('[')
  const hasObject = objectStart >= 0
  const hasArray = arrayStart >= 0

  let start = -1
  let end = -1

  if (hasObject && hasArray) {
    if (objectStart < arrayStart) {
      start = objectStart
      end = trimmed.lastIndexOf('}')
    } else {
      start = arrayStart
      end = trimmed.lastIndexOf(']')
    }
  } else if (hasObject) {
    start = objectStart
    end = trimmed.lastIndexOf('}')
  } else if (hasArray) {
    start = arrayStart
    end = trimmed.lastIndexOf(']')
  }

  if (start < 0 || end < start) return null

  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

export async function callOpenClawGateway<T = unknown>(
  method: string,
  params: unknown,
  timeoutMs = 10000,
): Promise<T> {
  const result = await runOpenClaw(
    [
      'gateway',
      'call',
      method,
      '--timeout',
      String(Math.max(1000, Math.floor(timeoutMs))),
      '--params',
      JSON.stringify(params ?? {}),
      '--json',
    ],
    { timeoutMs: timeoutMs + 2000 },
  )

  const payload = parseGatewayJsonOutput(result.stdout)
  if (payload == null) {
    throw new Error(`Invalid JSON response from gateway method ${method}`)
  }

  return payload as T
}

/**
 * Spawn an ACP session (e.g. Codex, Claude Code) via sessions_spawn.
 * Returns the sessionId immediately — the session runs asynchronously.
 */
const ACPX_BIN = '/root/.nvm/versions/node/v22.22.2/lib/node_modules/openclaw/node_modules/.bin/acpx'

/**
 * Spawn an ACP session via `acpx spawn --no-wait`.
 * This is non-blocking — returns immediately with the session name.
 * The agent writes PR URL to /tmp/mc-task-{taskId}.pr when done.
 */
export async function spawnAcpSession(params: {
  task: string
  agentId?: string
  model?: string
  label?: string
  cwd?: string
  timeoutSeconds?: number
  taskId?: number
}): Promise<{ sessionId: string; spawnId: string }> {
  const spawnId = `spawn-${Date.now()}-${randomUUID().slice(0, 8)}`
  const sessionName = params.label || `mc-task-${params.taskId || 'unknown'}`
  const cwd = params.cwd || process.cwd()

  // Build the prompt — include instruction to write PR URL to file
  const prFile = `/tmp/mc-task-${params.taskId}.pr`
  const instructionFile = params.taskId
    ? `/root/.openclaw/workspace/agent-instructions/developer.md`
    : null

  let fullTask = params.task
  if (params.taskId) {
    fullTask += `\n\nIMPORTANT: When you have created the Pull Request, write the PR URL to the file: ${prFile}`
    if (instructionFile) {
      fullTask += `\n\nAlso read these developer instructions: ${instructionFile}`
    }
  }

  // Spawn via acpx CLI --no-wait (non-blocking)
  const agent = params.agentId || 'codex'
  const args = [
    'spawn',
    '--no-wait',
    '--session', sessionName,
    '--format', 'quiet',
  ]
  if (params.model) {
    args.push('--model', params.model)
  }
  // Add model from agent if available
  if (agent === 'codex' && !params.model) {
    args.push('--model', 'openai-codex/gpt-5.4')
  }
  args.push('--', agent)

  const result = await runCommand(ACPX_BIN, args, {
    cwd,
    timeoutMs: 30_000,
    input: fullTask,
  })

  // acpx spawn --no-wait returns immediately. Exit code 0 means spawn succeeded.
  if (result.code !== 0) {
    throw new Error(`acpx spawn failed: ${result.stderr || result.stdout}`)
  }

  return { sessionId: sessionName, spawnId }
}

/**
 * Poll an ACP session's history until the agent completes or a timeout is reached.
 * Returns the final result text from the session.
 */
export async function pollAcpSessionUntilComplete(
  sessionId: string,
  timeoutMs = 300_000,
  pollIntervalMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let firstPoll = true

  while (Date.now() < deadline) {
    // First poll is immediate; subsequent polls wait the interval
    if (!firstPoll) {
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs))
    }
    firstPoll = false

    try {
      const history = await callOpenClawGateway<any>(
        'sessions_history',
        { sessionKey: sessionId, limit: 50 },
        10_000,
      )

      const messages: any[] = Array.isArray(history?.messages) ? history.messages
        : Array.isArray(history) ? history
        : []
      if (messages.length === 0) continue

      const lastMsg = messages[messages.length - 1]
      const status = String(lastMsg?.status ?? lastMsg?.state ?? '').toLowerCase()

      // Terminal states: completed/done = success, error/failed = throw
      if (status === 'done' || status === 'completed') {
        const textParts: string[] = []
        for (const msg of messages) {
          if (msg.role === 'assistant' || msg.type === 'assistant') {
            const text = msg.text ?? msg.content ?? msg.output ?? ''
            if (typeof text === 'string' && text.trim()) {
              textParts.push(text.trim())
            }
          }
        }
        if (textParts.length > 0) {
          return textParts.join('\n')
        }
        return JSON.stringify(lastMsg)
      }

      if (status === 'error' || status === 'failed') {
        throw new Error(`ACP session ${sessionId} ended with status: ${status}`)
      }
    } catch (err) {
      // Only re-throw structural errors; network/parse errors are retried
      if (err instanceof Error && err.message.includes(`ended with status`)) {
        throw err
      }
      console.warn(`pollAcpSessionUntilComplete: ${err}`)
    }
  }

  throw new Error(`ACP session ${sessionId} did not complete within ${timeoutMs}ms`)
}
