import { runOpenClaw } from './command'
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
export async function spawnAcpSession(params: {
  task: string
  agentId?: string
  model?: string
  label?: string
  cwd?: string
  timeoutSeconds?: number
}): Promise<{ sessionId: string; spawnId: string }> {
  const spawnId = `spawn-${Date.now()}-${randomUUID()}`
  const invokeParams: Record<string, unknown> = {
    task: params.task,
    runtime: 'acp',
    agentId: params.agentId || 'codex',
    mode: 'session',
    thread: false,
    label: params.label || spawnId,
  }
  if (params.model) invokeParams.model = params.model
  if (params.cwd) invokeParams.cwd = params.cwd
  if (params.timeoutSeconds) invokeParams.runTimeoutSeconds = params.timeoutSeconds

  const result = await callOpenClawGateway<any>(
    'sessions_spawn',
    invokeParams,
    15_000,
  )

  const sessionId: string | null =
    typeof result?.sessionId === 'string' ? result.sessionId
    : typeof result?.session_id === 'string' ? result.session_id
    : typeof result?.sessionKey === 'string' ? result.sessionKey
    : null

  if (!sessionId) {
    throw new Error(`sessions_spawn returned no sessionId: ${JSON.stringify(result)}`)
  }

  return { sessionId, spawnId }
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
