import { getDatabase, db_helpers } from './db'
import { runCommand, runOpenClaw } from './command'
import { callOpenClawGateway, closeAcpSession, spawnAcpSession } from './openclaw-gateway'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { config } from './config'
import { createIssueComment, fetchAuthenticatedUser, fetchPullRequest, submitPullRequestReview } from './github'

interface DispatchableTask {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  assigned_to: string
  workspace_id: number
  agent_name: string
  agent_id: number
  agent_config: string | null
  ticket_prefix: string | null
  project_ticket_no: number | null
  project_id: number | null
  github_default_branch?: string | null
  tags?: string[]
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

/**
 * Classify a task's complexity and return the appropriate model ID to pass
 * to the OpenClaw gateway. Uses keyword signals on title + description.
 *
 * Tiers:
 *   ROUTINE  → cheap model (Haiku)   — file ops, status checks, formatting
 *   MODERATE → mid model  (Sonnet)   — code gen, summaries, analysis, drafts
 *   COMPLEX  → premium model (Opus)  — debugging, architecture, novel problems
 *
 * The caller may override this by setting agent.config.dispatchModel.
 */
function classifyTaskModel(task: DispatchableTask): string | null {
  // Allow per-agent config override
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.dispatchModel === 'string' && cfg.dispatchModel) return cfg.dispatchModel
    } catch { /* ignore */ }
  }

  const text = `${task.title} ${task.description ?? ''}`.toLowerCase()
  const priority = task.priority?.toLowerCase() ?? ''

  // Complex signals → Opus
  const complexSignals = [
    'debug', 'diagnos', 'architect', 'design system', 'security audit',
    'root cause', 'investigate', 'incident', 'failure', 'broken', 'not working',
    'refactor', 'migration', 'performance optim', 'why is',
  ]
  if (priority === 'critical' || complexSignals.some(s => text.includes(s))) {
    return '9router/cc/claude-opus-4-6'
  }

  // Routine signals → Haiku
  const routineSignals = [
    'status check', 'health check', 'ping', 'list ', 'fetch ', 'format',
    'rename', 'move file', 'read file', 'update readme', 'bump version',
    'send message', 'post to', 'notify', 'summarize', 'translate',
    'quick ', 'simple ', 'routine ', 'minor ',
  ]
  if (priority === 'low' && routineSignals.some(s => text.includes(s))) {
    return '9router/cc/claude-haiku-4-5-20251001'
  }
  if (routineSignals.some(s => text.includes(s)) && priority !== 'high' && priority !== 'critical') {
    return '9router/cc/claude-haiku-4-5-20251001'
  }

  // Default: let the agent's own configured model handle it (no override)
  return null
}

/** Extract the gateway agent identifier from the agent's config JSON.
 *  Falls back to agent_name (display name) if openclawId is not set. */
function resolveGatewayAgentId(task: DispatchableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return task.agent_name
}

export function shouldAwaitPrBeforeReview(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false
  const prFile = (metadata as Record<string, unknown>).pr_file
  return typeof prFile === 'string' && prFile.trim().length > 0
}

export function getTaskBaseBranch(task: Pick<DispatchableTask, 'github_default_branch'>): string {
  const branch = String(task.github_default_branch || '').trim()
  if (!branch || branch === 'main') return 'dev'
  return branch
}

function getTaskReference(task: Pick<DispatchableTask, 'id' | 'ticket_prefix' | 'project_ticket_no'>): string {
  return task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`
}

function isNonRetriableReviewError(errorMsg: string): boolean {
  return errorMsg.includes('has no pr_url in metadata')
    || errorMsg.includes('has an invalid PR URL')
    || errorMsg.includes('no GitHub repo is configured')
}

function parsePorcelainPath(line: string): string {
  const trimmed = line.trimEnd()
  if (trimmed.length <= 3) return ''
  const payload = trimmed.slice(3)
  const renamed = payload.includes(' -> ') ? payload.split(' -> ').at(-1) || payload : payload
  return renamed.trim()
}

export function hasBlockingWorkspaceChanges(statusOutput: string): boolean {
  const lines = statusOutput
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)

  return lines.some((line) => {
    const path = parsePorcelainPath(line)
    if (!path) return true
    if (path === '.openclaw' || path.startsWith('.openclaw/')) return false
    return true
  })
}

async function validatePrWorkflowPrereqs(workspace: string): Promise<string | null> {
  try {
    await runCommand('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: workspace,
      timeoutMs: 10_000,
    })
  } catch {
    return `Workspace ${workspace} is not a git repository`
  }

  try {
    await runCommand('git', ['remote', 'get-url', 'origin'], {
      cwd: workspace,
      timeoutMs: 10_000,
    })
  } catch {
    return `Workspace ${workspace} has no origin remote configured`
  }

  try {
    await runCommand('gh', ['auth', 'status'], {
      cwd: workspace,
      timeoutMs: 15_000,
    })
  } catch (err: any) {
    return `GitHub CLI auth check failed: ${err.message || 'gh auth status failed'}`
  }

  return null
}

export async function prepareWorkspaceForTask(workspace: string, baseBranch: string): Promise<void> {
  await runCommand('git', ['reset', '--hard', 'HEAD'], {
    cwd: workspace,
    timeoutMs: 10_000,
  })
  await runCommand('git', ['clean', '-fd', '-e', '.openclaw'], {
    cwd: workspace,
    timeoutMs: 10_000,
  })

  await runCommand('git', ['fetch', 'origin', baseBranch], {
    cwd: workspace,
    timeoutMs: 30_000,
  })

  try {
    await runCommand('git', ['checkout', baseBranch], {
      cwd: workspace,
      timeoutMs: 15_000,
    })
  } catch {
    await runCommand('git', ['checkout', '-b', baseBranch, '--track', `origin/${baseBranch}`], {
      cwd: workspace,
      timeoutMs: 15_000,
    })
  }

  await runCommand('git', ['pull', '--ff-only', 'origin', baseBranch], {
    cwd: workspace,
    timeoutMs: 30_000,
  })

  await runCommand('git', ['reset', '--hard', `origin/${baseBranch}`], {
    cwd: workspace,
    timeoutMs: 15_000,
  })
  await runCommand('git', ['clean', '-fd', '-e', '.openclaw'], {
    cwd: workspace,
    timeoutMs: 10_000,
  })
}

export function buildDispatchFailureNotificationTitle(task: Pick<DispatchableTask, 'id' | 'title' | 'ticket_prefix' | 'project_ticket_no'>): string {
  return `Dispatch failed for [${getTaskReference(task)}] ${task.title}`
}

export function buildDispatchFailureNotificationMessage(
  task: Pick<DispatchableTask, 'id' | 'title' | 'ticket_prefix' | 'project_ticket_no'>,
  errorMsg: string,
  baseBranch: string,
  workspace: string,
  attempts: number,
  maxDispatchRetries: number,
): string {
  const attemptsNote = attempts >= maxDispatchRetries
    ? `Dispatch permanently failed after ${attempts}/${maxDispatchRetries} attempts.`
    : `Dispatch retry ${attempts}/${maxDispatchRetries} failed.`

  return [
    `${attemptsNote} Base branch: ${baseBranch}.`,
    `Workspace: ${workspace}.`,
    `Error: ${errorMsg.substring(0, 1000)}`,
  ].join(' ')
}

export function buildDispatchFailureComment(
  task: Pick<DispatchableTask, 'id' | 'title' | 'ticket_prefix' | 'project_ticket_no'>,
  errorMsg: string,
  baseBranch: string,
  workspace: string,
  attempts: number,
  maxDispatchRetries: number,
): string {
  const attemptsNote = attempts >= maxDispatchRetries
    ? `Dispatch permanently failed after ${attempts}/${maxDispatchRetries} attempts.`
    : `Dispatch attempt ${attempts}/${maxDispatchRetries} failed.`

  return [
    `Dispatch error for [${getTaskReference(task)}] ${task.title}`,
    '',
    attemptsNote,
    `Base branch: ${baseBranch}`,
    `Workspace: ${workspace}`,
    '',
    errorMsg.substring(0, 5000),
  ].join('\n')
}

export function buildMissingPrReviewError(task: Pick<DispatchableTask, 'id' | 'title' | 'ticket_prefix' | 'project_ticket_no'>): string {
  return `Task [${getTaskReference(task)}] ${task.title} cannot move to review without a PR URL in metadata`
}

export function buildTaskPrompt(task: DispatchableTask, rejectionFeedback?: string | null): string {
  const ticket = getTaskReference(task)
  const baseBranch = getTaskBaseBranch(task)

  const lines = [
    'You have been assigned a task in Mission Control.',
    '',
    `**[${ticket}] ${task.title}**`,
    `Priority: ${task.priority}`,
  ]

  if (task.tags && task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(', ')}`)
  }

  if (task.description) {
    lines.push('', task.description)
  }

  if (rejectionFeedback) {
    lines.push('', '## Previous Review Feedback', rejectionFeedback, '', 'Please address this feedback in your response.')
  }

  lines.push('',
    '## IMPORTANT: Pull Request Required',
    'You MUST create a Pull Request for this task. Follow these steps:',
    `1. Return to the base branch: git checkout ${baseBranch}`,
    `2. Update it: git fetch origin ${baseBranch} && git reset --hard origin/${baseBranch}`,
    `3. Create your task branch from ${baseBranch}: git checkout -b task-${task.id}/description`,
    '4. Make your changes',
    `5. Commit: git commit -m "[TASK-${task.id}] description"`,
    `6. Push: git push -u origin task-${task.id}/description`,
    `7. Create PR: gh pr create --base ${baseBranch} --title "[TASK-${task.id}] ${task.title}" --body "Task: TASK-${task.id}"`,
    `8. Write the PR URL to: /tmp/mc-task-${task.id}.pr`,
    '',
    `The PR must be created before marking the task as complete. Always branch from the latest ${baseBranch}. Mission Control will detect the PR and move the task to review.`)
  return lines.join('\n')
}

/** Extract first valid JSON object from raw stdout (handles surrounding text/warnings). */
function parseGatewayJson(raw: string): any | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

interface AgentResponseParsed {
  text: string | null
  sessionId: string | null
}

function parseAgentResponse(stdout: string): AgentResponseParsed {
  try {
    const parsed = JSON.parse(stdout)
    const sessionId: string | null = typeof parsed?.sessionId === 'string' ? parsed.sessionId
      : typeof parsed?.session_id === 'string' ? parsed.session_id
      : null

    // OpenClaw agent --json returns { payloads: [{ text: "..." }] }
    if (parsed?.payloads?.[0]?.text) {
      return { text: parsed.payloads[0].text, sessionId }
    }
    // Fallback: if there's a result or output field
    if (parsed?.result) return { text: String(parsed.result), sessionId }
    if (parsed?.output) return { text: String(parsed.output), sessionId }
    // Last resort: stringify the whole response
    return { text: JSON.stringify(parsed, null, 2), sessionId }
  } catch {
    // Not valid JSON — return raw stdout if non-empty
    return { text: stdout.trim() || null, sessionId: null }
  }
}

// ---------------------------------------------------------------------------
// Direct Claude API dispatch (gateway-free)
// ---------------------------------------------------------------------------

function getAnthropicApiKey(): string | null {
  return (process.env.ANTHROPIC_API_KEY || '').trim() || null
}

function isGatewayAvailable(): boolean {
  // Gateway is available if OpenClaw is installed OR a gateway is registered in the DB
  if (config.openclawHome) return true
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT COUNT(*) as c FROM gateways').get() as { c: number } | undefined
    return (row?.c ?? 0) > 0
  } catch {
    return false
  }
}

function classifyDirectModel(task: DispatchableTask): string {
  // Check per-agent config override first
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.dispatchModel === 'string' && cfg.dispatchModel) {
        // Strip gateway prefixes like "9router/cc/" to get bare model ID
        return cfg.dispatchModel.replace(/^.*\//, '')
      }
    } catch { /* ignore */ }
  }

  const text = `${task.title} ${task.description ?? ''}`.toLowerCase()
  const priority = task.priority?.toLowerCase() ?? ''

  // Complex → Opus
  const complexSignals = [
    'debug', 'diagnos', 'architect', 'design system', 'security audit',
    'root cause', 'investigate', 'incident', 'refactor', 'migration',
  ]
  if (priority === 'critical' || complexSignals.some(s => text.includes(s))) {
    return 'claude-opus-4-6'
  }

  // Routine → Haiku
  const routineSignals = [
    'status check', 'health check', 'format', 'rename', 'summarize',
    'translate', 'quick ', 'simple ', 'routine ', 'minor ',
  ]
  if (routineSignals.some(s => text.includes(s)) && priority !== 'high' && priority !== 'critical') {
    return 'claude-haiku-4-5-20251001'
  }

  // Default → Sonnet
  return 'claude-sonnet-4-6'
}

function getAgentSoulContent(task: DispatchableTask): string | null {
  try {
    const db = getDatabase()
    const row = db.prepare(
      'SELECT soul_content FROM agents WHERE id = ? AND workspace_id = ?'
    ).get(task.agent_id, task.workspace_id) as { soul_content: string | null } | undefined
    return row?.soul_content || null
  } catch {
    return null
  }
}

async function callClaudeDirectly(
  task: DispatchableTask,
  prompt: string,
): Promise<AgentResponseParsed> {
  const apiKey = getAnthropicApiKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — cannot dispatch without gateway')

  const model = classifyDirectModel(task)
  const soul = getAgentSoulContent(task)

  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: prompt },
  ]

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages,
  }

  if (soul) {
    body.system = soul
  }

  logger.info({ taskId: task.id, model, agent: task.agent_name }, 'Dispatching task via direct Claude API')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '')
    throw new Error(`Claude API ${res.status}: ${errorBody.substring(0, 500)}`)
  }

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  const text = data.content
    ?.filter((b: { type: string }) => b.type === 'text')
    .map((b: { text?: string }) => b.text || '')
    .join('\n') || null

  // Record token usage
  if (data.usage) {
    try {
      const db = getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare(`
        INSERT INTO token_usage (model, session_id, input_tokens, output_tokens, total_tokens, cost, created_at, workspace_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        model,
        `task-${task.id}`,
        data.usage.input_tokens || 0,
        data.usage.output_tokens || 0,
        (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        0, // cost calculated separately
        now,
        task.workspace_id,
      )
    } catch { /* non-fatal */ }
  }

  return { text, sessionId: null }
}

interface ReviewableTask {
  id: number
  title: string
  description: string | null
  resolution: string | null
  assigned_to: string | null
  agent_config: string | null
  workspace_id: number
  ticket_prefix: string | null
  project_ticket_no: number | null
  metadata: string | null
  github_repo: string | null
  dispatch_attempts: number
}

interface TaskMetadata {
  dispatch_session_id?: string
  target_session?: string
  pr_url?: string
  pr_file?: string
  workspace?: string
  cwd?: string
}

function getTaskWorkspace(metadata: TaskMetadata): string {
  return metadata.workspace || metadata.cwd || '/root/things/profitstack-next'
}

function resolveGatewayAgentIdForReview(task: ReviewableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  const agentName = task.assigned_to || 'main'
  const agentIdMap: Record<string, string> = {
    'claude-code-dev': 'codex',
    'codex-dev': 'codex',
    'test-claude': 'claude',
  }
  return agentIdMap[agentName] || 'main'
}

function resolveGatewayAgentIdForDeveloper(task: Pick<ReviewableTask, 'assigned_to' | 'agent_config'>): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return String(task.assigned_to || '').trim() || 'main'
}

function buildReviewPrompt(task: ReviewableTask): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You are Aegis, the quality reviewer for Mission Control.',
    'Review the following completed task and its resolution.',
    '',
    `**[${ticket}] ${task.title}**`,
  ]

  if (task.description) {
    lines.push('', '## Task Description', task.description)
  }

  if (task.resolution) {
    lines.push('', '## Agent Resolution', task.resolution.substring(0, 6000))
  }

  const metadata = parseTaskMetadata(task.metadata)
  if (metadata.pr_url) {
    lines.push('', '## Pull Request', metadata.pr_url)
  }

  lines.push(
    '',
    '## Instructions',
    'Evaluate whether the agent\'s response adequately addresses the task.',
    'Respond with EXACTLY one of these two formats:',
    '',
    'If the work is acceptable:',
    'VERDICT: APPROVED',
    'NOTES: <brief summary of why it passes>',
    '',
    'If the work needs improvement:',
    'VERDICT: REJECTED',
    'NOTES: <specific issues that need to be fixed>',
  )

  return lines.join('\n')
}

function parseReviewVerdict(text: string): { status: 'approved' | 'rejected'; notes: string } {
  const upper = text.toUpperCase()
  const status = upper.includes('VERDICT: APPROVED') ? 'approved' as const : 'rejected' as const
  const notesMatch = text.match(/NOTES:\s*([\s\S]+?)\s*$/i)
  const extractedNotes = notesMatch?.[1]?.trim() || ''
  const notes = extractedNotes.substring(0, 2000) || (status === 'approved' ? 'Quality check passed' : 'Quality check failed')
  return { status, notes }
}

function parseTaskMetadata(metadata: string | null | undefined): TaskMetadata {
  if (!metadata) return {}
  try {
    const parsed = JSON.parse(metadata)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function parsePullRequestReference(prUrl: string): { repo: string; pullNumber: number } | null {
  const match = String(prUrl || '').trim().match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:\/.*)?$/i)
  if (!match) return null
  return { repo: match[1], pullNumber: Number(match[2]) }
}

export function buildAegisReviewComment(
  status: 'approved' | 'rejected',
  notes: string,
  prUrl: string,
): string {
  const verdict = status === 'approved' ? 'APPROVED' : 'REQUEST_CHANGES'
  return [
    `Aegis Review: ${verdict}`,
    `PR: ${prUrl}`,
    '',
    status === 'approved' ? 'Summary:' : 'Reason:',
    notes.trim(),
  ].join('\n')
}

export function buildReworkPrompt(task: ReviewableTask, notes: string, prUrl: string): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  return [
    `Mission Control review requested changes for [${ticket}] ${task.title}.`,
    '',
    `PR to update: ${prUrl}`,
    '',
    'Review feedback:',
    notes.trim(),
    '',
    'Update the existing branch and the existing PR. Do not open a new PR.',
    'Apply the requested changes, commit them, push to the same branch, and when the PR is ready for another review write the same PR URL back to the task PR file.',
    `Write the PR URL to: /tmp/mc-task-${task.id}.pr`,
  ].join('\n')
}

function getReusableTaskSession(metadata: TaskMetadata): string | null {
  const targetSession = String(metadata.target_session || '').trim()
  if (targetSession) return targetSession
  const dispatchSession = String(metadata.dispatch_session_id || '').trim()
  return dispatchSession || null
}

async function sendTaskPromptToSession(taskId: number, sessionKey: string, message: string): Promise<void> {
  const sendResult = await callOpenClawGateway<any>(
    'chat.send',
    {
      sessionKey,
      message,
      idempotencyKey: `task-rework-${taskId}-${Date.now()}`,
      deliver: false,
    },
    125_000,
  )
  const status = String(sendResult?.status || '').toLowerCase()
  if (status !== 'started' && status !== 'ok' && status !== 'in_flight') {
    throw new Error(`chat.send to session ${sessionKey} returned status: ${status}`)
  }
}

async function publishAegisReview(
  repo: string,
  pullNumber: number,
  review: {
    body: string
    event: 'APPROVE' | 'REQUEST_CHANGES'
  },
): Promise<'review' | 'comment'> {
  const [pr, viewer] = await Promise.all([
    fetchPullRequest(repo, pullNumber),
    fetchAuthenticatedUser(),
  ])

  const prAuthor = String(pr.user?.login || '').trim().toLowerCase()
  const viewerLogin = String(viewer.login || '').trim().toLowerCase()
  if (prAuthor && viewerLogin && prAuthor === viewerLogin) {
    await createIssueComment(repo, pullNumber, review.body)
    return 'comment'
  }

  await submitPullRequestReview(repo, pullNumber, review)
  return 'review'
}

/**
 * Run Aegis quality reviews on tasks in 'review' status.
 * Uses an agent to evaluate the task resolution, then approves or rejects.
 */
export async function runAegisReviews(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.description, t.resolution, t.assigned_to, t.workspace_id,
           t.metadata, t.dispatch_attempts,
           p.ticket_prefix, t.project_ticket_no, p.github_repo, a.config as agent_config
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'review'
    ORDER BY t.updated_at ASC
    LIMIT 3
  `).all() as ReviewableTask[]

  if (tasks.length === 0) {
    return { ok: true, message: 'No tasks awaiting review' }
  }

  const results: Array<{ id: number; verdict: string; error?: string }> = []

  for (const task of tasks) {
    // Move to quality_review to prevent re-processing
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run('quality_review', Math.floor(Date.now() / 1000), task.id)

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'quality_review',
      previous_status: 'review',
    })

    try {
      const prompt = buildReviewPrompt(task)
      const metadata = parseTaskMetadata(task.metadata)
      const prUrl = String(metadata.pr_url || '').trim()
      if (!prUrl) {
        throw new Error(`Task ${task.id} is awaiting review but has no pr_url in metadata`)
      }
      const parsedPr = parsePullRequestReference(prUrl)
      if (!parsedPr) {
        throw new Error(`Task ${task.id} has an invalid PR URL: ${prUrl}`)
      }
      const repo = String(task.github_repo || parsedPr.repo).trim()
      if (!repo) {
        throw new Error(`Task ${task.id} is awaiting review but no GitHub repo is configured`)
      }
      let agentResponse: AgentResponseParsed

      if (!isGatewayAvailable() && getAnthropicApiKey()) {
        // Direct Claude API review — no gateway needed
        const reviewTask: DispatchableTask = {
          id: task.id, title: task.title, description: task.description,
          status: 'quality_review', priority: 'high', assigned_to: 'aegis',
          workspace_id: task.workspace_id, agent_name: 'aegis', agent_id: 0,
          agent_config: null, ticket_prefix: task.ticket_prefix,
          project_ticket_no: task.project_ticket_no, project_id: null,
        }
        agentResponse = await callClaudeDirectly(reviewTask, prompt)
      } else {
        // Resolve the gateway agent ID from config, falling back to assigned_to or default
        const reviewAgent = resolveGatewayAgentIdForReview(task)

        const invokeParams = {
          message: prompt,
          agentId: reviewAgent,
          idempotencyKey: `aegis-review-${task.id}-${Date.now()}`,
          deliver: false,
        }
        const finalResult = await runOpenClaw(
          ['gateway', 'call', 'agent', '--expect-final', '--timeout', '120000', '--params', JSON.stringify(invokeParams), '--json'],
          { timeoutMs: 125_000 }
        )
        const finalPayload = parseGatewayJson(finalResult.stdout)
          ?? parseGatewayJson(String((finalResult as any)?.stderr || ''))
        agentResponse = parseAgentResponse(
          finalPayload?.result ? JSON.stringify(finalPayload.result) : finalResult.stdout
        )
      }

      if (!agentResponse.text) {
        throw new Error('Aegis review returned empty response')
      }

      const verdict = parseReviewVerdict(agentResponse.text)
      const reviewComment = buildAegisReviewComment(verdict.status, verdict.notes, prUrl)
      const reviewDelivery = await publishAegisReview(repo, parsedPr.pullNumber, {
        body: reviewComment,
        event: verdict.status === 'approved' ? 'APPROVE' : 'REQUEST_CHANGES',
      })

      // Insert quality review record
      db.prepare(`
        INSERT INTO quality_reviews (task_id, reviewer, status, notes, workspace_id)
        VALUES (?, 'aegis', ?, ?, ?)
      `).run(task.id, verdict.status, verdict.notes, task.workspace_id)

      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, 'aegis', ?, ?, ?)
      `).run(task.id, reviewComment, Math.floor(Date.now() / 1000), task.workspace_id)

      if (verdict.status === 'approved') {
        db.prepare('UPDATE tasks SET status = ?, error_message = NULL, updated_at = ? WHERE id = ?')
          .run('done', Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'done',
          previous_status: 'quality_review',
        })
      } else {
        const now = Math.floor(Date.now() / 1000)
        const newAttempts = (task.dispatch_attempts ?? 0) + 1
        const priorSession = getReusableTaskSession(metadata)
        const workspace = getTaskWorkspace(metadata)
        if (priorSession) {
          try {
            await closeAcpSession(priorSession, workspace)
          } catch (err) {
            logger.warn({ taskId: task.id, sessionId: priorSession, err }, 'Failed to close prior developer session before rework')
          }
        }
        const spawned = await spawnAcpSession({
          task: buildReworkPrompt(task, verdict.notes, prUrl),
          agentId: resolveGatewayAgentIdForDeveloper(task),
          label: `mc-task-${task.id}-rework`,
          cwd: workspace,
          taskId: task.id,
        })
        const targetSession = spawned.sessionId
        const updatedMeta = {
          ...metadata,
          target_session: targetSession,
          dispatch_session_id: targetSession,
          pr_url: prUrl,
          pr_file: metadata.pr_file || `/tmp/mc-task-${task.id}.pr`,
          workspace,
        }

        db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, metadata = ?, updated_at = ? WHERE id = ?')
          .run('in_progress', `Aegis requested changes: ${verdict.notes}`, newAttempts, JSON.stringify(updatedMeta), now, task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'in_progress',
          previous_status: 'quality_review',
          error_message: `Aegis requested changes: ${verdict.notes}`,
          reason: 'aegis_rejection',
        })
      }

      db_helpers.logActivity(
        'aegis_review',
        'task',
        task.id,
        'aegis',
        `Aegis ${verdict.status} task "${task.title}": ${verdict.notes.substring(0, 200)}`,
        { verdict: verdict.status, notes: verdict.notes, delivery: reviewDelivery },
        task.workspace_id
      )

      results.push({ id: task.id, verdict: verdict.status })
      logger.info({ taskId: task.id, verdict: verdict.status }, 'Aegis review completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, err }, 'Aegis review failed')

      if (isNonRetriableReviewError(errorMsg)) {
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, updated_at = ? WHERE id = ?')
          .run('failed', errorMsg.substring(0, 500), Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'failed',
          previous_status: 'quality_review',
          error_message: errorMsg.substring(0, 500),
          reason: 'invalid_review_state',
        })
      } else {
        // Revert to review so transient errors can be retried
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
          .run('review', Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'review',
          previous_status: 'quality_review',
        })
      }

      results.push({ id: task.id, verdict: 'error', error: errorMsg.substring(0, 100) })
    }
  }

  const approved = results.filter(r => r.verdict === 'approved').length
  const rejected = results.filter(r => r.verdict === 'rejected').length
  const errors = results.filter(r => r.verdict === 'error').length

  return {
    ok: errors === 0,
    message: `Reviewed ${tasks.length}: ${approved} approved, ${rejected} rejected${errors ? `, ${errors} error(s)` : ''}`,
  }
}

/**
 * Requeue stale tasks stuck in 'in_progress' whose assigned agent is offline.
 * Prevents tasks from being permanently stuck when agents crash or disconnect.
 */
export async function requeueStaleTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const staleThreshold = now - 10 * 60 // 10 minutes
  const maxDispatchRetries = 5

  const staleTasks = db.prepare(`
    SELECT t.id, t.title, t.assigned_to, t.dispatch_attempts, t.workspace_id,
           a.status as agent_status, a.last_seen as agent_last_seen
    FROM tasks t
    LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'in_progress'
      AND t.updated_at < ?
  `).all(staleThreshold) as Array<{
    id: number; title: string; assigned_to: string | null; dispatch_attempts: number
    workspace_id: number; agent_status: string | null; agent_last_seen: number | null
  }>

  if (staleTasks.length === 0) {
    return { ok: true, message: 'No stale tasks found' }
  }

  let requeued = 0
  let failed = 0

  for (const task of staleTasks) {
    // Only requeue if the agent is offline or unknown
    const agentOffline = !task.agent_status || task.agent_status === 'offline'
    if (!agentOffline) continue

    const newAttempts = (task.dispatch_attempts ?? 0) + 1

    if (newAttempts >= maxDispatchRetries) {
      db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
        .run('failed', `Task stuck in_progress ${newAttempts} times — agent "${task.assigned_to}" offline. Moved to failed.`, newAttempts, now, task.id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'failed',
        previous_status: 'in_progress',
        error_message: `Stale task — agent offline after ${newAttempts} attempts`,
        reason: 'stale_task_max_retries',
      })

      failed++
    } else {
      db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
        .run('assigned', `Requeued: agent "${task.assigned_to}" went offline while task was in_progress`, newAttempts, now, task.id)

      // Add a comment explaining the requeue
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, 'scheduler', ?, ?, ?)
      `).run(task.id, `Task requeued (attempt ${newAttempts}/${maxDispatchRetries}): agent "${task.assigned_to}" went offline while task was in_progress.`, now, task.workspace_id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'assigned',
        previous_status: 'in_progress',
        error_message: `Agent "${task.assigned_to}" went offline`,
        reason: 'stale_task_requeue',
      })

      requeued++
    }
  }

  const total = requeued + failed
  return {
    ok: true,
    message: total === 0
      ? `Found ${staleTasks.length} stale task(s) but agents still online`
      : `Requeued ${requeued}, failed ${failed} of ${staleTasks.length} stale task(s)`,
  }
}

export async function dispatchAssignedTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const tasks = db.prepare(`
    SELECT t.*, a.name as agent_name, a.id as agent_id, a.config as agent_config,
           p.ticket_prefix, t.project_ticket_no, p.github_default_branch
    FROM tasks t
    JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.status = 'assigned'
      AND t.assigned_to IS NOT NULL
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      t.created_at ASC
    LIMIT 3
  `).all() as (DispatchableTask & { tags?: string })[]

  if (tasks.length === 0) {
    return { ok: true, message: 'No assigned tasks to dispatch' }
  }

  // Parse JSON tags column
  for (const task of tasks) {
    if (typeof task.tags === 'string') {
      try { task.tags = JSON.parse(task.tags as string) } catch { task.tags = undefined }
    }
  }

  const results: Array<{ id: number; success: boolean; error?: string }> = []
  const now = Math.floor(Date.now() / 1000)

  for (const task of tasks) {
    let workspace = '/root/things/profitstack-next'
    const baseBranch = getTaskBaseBranch(task)

    // Mark as in_progress immediately to prevent re-dispatch
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run('in_progress', now, task.id)

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'in_progress',
      previous_status: 'assigned',
    })

    db_helpers.logActivity(
      'task_dispatched',
      'task',
      task.id,
      'scheduler',
      `Dispatching task "${task.title}" to agent ${task.agent_name}`,
      { agent: task.agent_name, priority: task.priority },
      task.workspace_id
    )

    try {
      // Check for previous Aegis rejection feedback
      const rejectionRow = db.prepare(`
        SELECT content FROM comments
        WHERE task_id = ? AND author = 'aegis' AND content LIKE 'Aegis Review: REQUEST_CHANGES%'
        ORDER BY created_at DESC LIMIT 1
      `).get(task.id) as { content: string } | undefined
      const rejectionFeedback = rejectionRow?.content?.replace(/^Aegis Review: REQUEST_CHANGES\s+PR:\s+\S+\s*/i, '').trim() || null

      const prompt = buildTaskPrompt(task, rejectionFeedback)

      const taskMeta = (() => {
        try {
          const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(task.id) as { metadata: string } | undefined
          return row?.metadata ? JSON.parse(row.metadata) : {}
        } catch { return {} }
      })()
      const dispatchModel = classifyTaskModel(task)
      const resolvedAgentId = resolveGatewayAgentId(task)
      const prFile = `/tmp/mc-task-${task.id}.pr`
      workspace = taskMeta?.workspace || taskMeta?.cwd || workspace
      const priorSession = getReusableTaskSession(taskMeta)

      let agentResponse: AgentResponseParsed
      let finalizeImmediately = true
      const useDirectApi = !isGatewayAvailable() && getAnthropicApiKey()

      if (priorSession) {
        try {
          await closeAcpSession(priorSession, workspace)
        } catch (err) {
          logger.warn({ taskId: task.id, sessionId: priorSession, err }, 'Failed to close prior task session before fresh dispatch')
        }
      }

      if (useDirectApi) {
        // Direct Claude API dispatch — no gateway needed
        agentResponse = await callClaudeDirectly(task, prompt)
      } else {
        // Spawn via acpx spawn --no-wait (non-blocking).
        // Agent writes PR URL to /tmp/mc-task-{id}.pr when done.
        // A separate pr_check scheduler job detects PR creation and moves to review.
        const prereqError = await validatePrWorkflowPrereqs(workspace)
        if (prereqError) {
          throw new Error(prereqError)
        }
        await prepareWorkspaceForTask(workspace, baseBranch)

        let acpSessionId: string | null = null

        try {
          const spawnResult = await spawnAcpSession({
            task: prompt,
            agentId: resolvedAgentId,
            model: dispatchModel ?? undefined,
            label: `mc-task-${task.id}`,
            cwd: workspace,
            taskId: task.id,
          })
          acpSessionId = spawnResult.sessionId
          finalizeImmediately = false
          logger.info({ taskId: task.id, sessionId: acpSessionId, workspace, agentId: resolvedAgentId }, 'ACP session spawned via acpx, waiting for PR')

          agentResponse = {
            text: `[Task dispatched to ${resolvedAgentId}. Agent is working on branch task-${task.id}/... PR will be created and task moved to review when ready.]`,
            sessionId: acpSessionId,
          }
        } catch (err: any) {
          // Spawn failed — fall back to blocking gateway call
          logger.warn({ taskId: task.id, err: err.message }, 'acpx spawn failed, falling back to gateway')
          // Use deliver: true - gateway will deliver result to callback channel (SSE/WebSocket)
          // For now we don't have a callback listener, so use --expect-final to get result inline
          const invokeParams: Record<string, unknown> = {
            message: prompt,
            agentId: resolvedAgentId,
            idempotencyKey: `task-dispatch-${task.id}-${Date.now()}`,
            deliver: true,
          }
          if (dispatchModel) invokeParams.model = dispatchModel

          // Try non-blocking first (without --expect-final). If no callback listener,
          // gateway will hold result until agent completes, then deliver to SSE.
          // We use --expect-final as fallback to get result inline.
          const finalResult = await runOpenClaw(
            ['gateway', 'call', 'agent', '--expect-final', '--timeout', '120000', '--params', JSON.stringify(invokeParams), '--json'],
            { timeoutMs: 125_000 }
          )
          const finalPayload = parseGatewayJson(finalResult.stdout)
            ?? parseGatewayJson(String((finalResult as any)?.stderr || ''))

          agentResponse = parseAgentResponse(
            finalPayload?.result ? JSON.stringify(finalPayload.result) : finalResult.stdout
          )
          if (!agentResponse.sessionId && finalPayload?.result?.meta?.agentMeta?.sessionId) {
            agentResponse.sessionId = finalPayload.result.meta.agentMeta.sessionId
          }
        }
      } // end else (new session dispatch)

      if (!agentResponse.text) {
        throw new Error('Agent returned empty response')
      }

      const truncated = agentResponse.text.length > 10_000
        ? agentResponse.text.substring(0, 10_000) + '\n\n[Response truncated at 10,000 characters]'
        : agentResponse.text

      // Merge dispatch_session_id into existing metadata
      const existingMeta = (() => {
        try {
          const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(task.id) as { metadata: string } | undefined
          return row?.metadata ? JSON.parse(row.metadata) : {}
        } catch { return {} }
      })()
      if (agentResponse.sessionId) {
        existingMeta.dispatch_session_id = agentResponse.sessionId
      }
      if (!finalizeImmediately) {
        delete existingMeta.target_session
        existingMeta.pr_file = prFile
        existingMeta.workspace = workspace
      } else {
        delete existingMeta.pr_file
        delete existingMeta.target_session
      }

      if (!finalizeImmediately && shouldAwaitPrBeforeReview(existingMeta)) {
        db.prepare('UPDATE tasks SET metadata = ?, updated_at = ? WHERE id = ?')
          .run(JSON.stringify(existingMeta), Math.floor(Date.now() / 1000), task.id)

        db.prepare(`
          INSERT INTO comments (task_id, author, content, created_at, workspace_id)
          VALUES (?, 'scheduler', ?, ?, ?)
        `).run(
          task.id,
          truncated,
          Math.floor(Date.now() / 1000),
          task.workspace_id
        )

        eventBus.broadcast('task.updated', {
          id: task.id,
          status: 'in_progress',
          assigned_to: task.assigned_to,
          dispatch_session_id: agentResponse.sessionId,
        })

        db_helpers.logActivity(
          'task_agent_started',
          'task',
          task.id,
          'scheduler',
          `Agent accepted task "${task.title}" and is working asynchronously`,
          { dispatch_session_id: agentResponse.sessionId, pr_file: existingMeta.pr_file, workspace: existingMeta.workspace },
          task.workspace_id
        )

        results.push({ id: task.id, success: true })
        logger.info({ taskId: task.id, agent: task.agent_name, sessionId: agentResponse.sessionId }, 'Task dispatched asynchronously; awaiting PR')
        continue
      }

      if (!String(existingMeta.pr_url || '').trim()) {
        throw new Error(buildMissingPrReviewError(task))
      }

      // Update task: status → review, set outcome
      db.prepare(`
        UPDATE tasks SET status = ?, outcome = ?, resolution = ?, metadata = ?, updated_at = ? WHERE id = ?
      `).run('review', 'success', truncated, JSON.stringify(existingMeta), Math.floor(Date.now() / 1000), task.id)

      // Add a comment from the agent with the full response
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.agent_name,
        truncated,
        Math.floor(Date.now() / 1000),
        task.workspace_id
      )

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'in_progress',
      })

      eventBus.broadcast('task.updated', {
        id: task.id,
        status: 'review',
        outcome: 'success',
        assigned_to: task.assigned_to,
        dispatch_session_id: agentResponse.sessionId,
      })

      db_helpers.logActivity(
        'task_agent_completed',
        'task',
        task.id,
        task.agent_name,
        `Agent completed task "${task.title}" — awaiting review`,
        { response_length: agentResponse.text.length, dispatch_session_id: agentResponse.sessionId },
        task.workspace_id
      )

      results.push({ id: task.id, success: true })
      logger.info({ taskId: task.id, agent: task.agent_name }, 'Task dispatched and completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, agent: task.agent_name, err }, 'Task dispatch failed')

      // Increment dispatch_attempts and decide next status
      const currentAttempts = (db.prepare('SELECT dispatch_attempts FROM tasks WHERE id = ?').get(task.id) as { dispatch_attempts: number } | undefined)?.dispatch_attempts ?? 0
      const newAttempts = currentAttempts + 1
      const maxDispatchRetries = 5

      if (newAttempts >= maxDispatchRetries) {
        // Too many failures — move to failed
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
          .run('failed', `Dispatch failed ${newAttempts} times. Last: ${errorMsg.substring(0, 5000)}`, newAttempts, Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'failed',
          previous_status: 'in_progress',
          error_message: `Dispatch failed ${newAttempts} times`,
          reason: 'max_dispatch_retries_exceeded',
        })
      } else {
        // Revert to assigned so it can be retried on the next tick
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
          .run('assigned', errorMsg.substring(0, 5000), newAttempts, Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'assigned',
          previous_status: 'in_progress',
          error_message: errorMsg.substring(0, 500),
          reason: 'dispatch_failed',
        })
      }

      const notificationTitle = buildDispatchFailureNotificationTitle(task)
      const notificationMessage = buildDispatchFailureNotificationMessage(
        task,
        errorMsg,
        baseBranch,
        workspace,
        newAttempts,
        maxDispatchRetries,
      )
      const commentBody = buildDispatchFailureComment(
        task,
        errorMsg,
        baseBranch,
        workspace,
        newAttempts,
        maxDispatchRetries,
      )

      try {
        db_helpers.createNotification(
          task.assigned_to || task.agent_name,
          'dispatch_error',
          notificationTitle,
          notificationMessage,
          'task',
          task.id,
          task.workspace_id,
        )
      } catch (notifyErr) {
        logger.warn({ taskId: task.id, err: notifyErr }, 'Failed to create dispatch error notification')
      }

      try {
        db.prepare(`
          INSERT INTO comments (task_id, author, content, created_at, workspace_id)
          VALUES (?, 'scheduler', ?, ?, ?)
        `).run(
          task.id,
          commentBody,
          Math.floor(Date.now() / 1000),
          task.workspace_id
        )
      } catch (commentErr) {
        logger.warn({ taskId: task.id, err: commentErr }, 'Failed to store dispatch error comment')
      }

      eventBus.broadcast('task.updated', {
        id: task.id,
        status: newAttempts >= maxDispatchRetries ? 'failed' : 'assigned',
        error_message: errorMsg.substring(0, 500),
        dispatch_attempts: newAttempts,
      })

      db_helpers.logActivity(
        'task_dispatch_failed',
        'task',
        task.id,
        'scheduler',
        `Task dispatch failed for "${task.title}": ${errorMsg.substring(0, 200)}`,
        { error: errorMsg.substring(0, 1000) },
        task.workspace_id
      )

      results.push({ id: task.id, success: false, error: errorMsg.substring(0, 100) })
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const failSummary = failed.length > 0
    ? ` (${failed.length} failed: ${failed.map(f => f.error).join('; ')})`
    : ''

  return {
    ok: failed.length === 0,
    message: `Dispatched ${succeeded}/${tasks.length} tasks${failSummary}`,
  }
}

// ---------------------------------------------------------------------------
// Auto-routing: assign inbox tasks to available agents
// ---------------------------------------------------------------------------

/** Role affinity mapping — which task keywords match which agent roles. */
const ROLE_AFFINITY: Record<string, string[]> = {
  coder: ['code', 'implement', 'build', 'fix', 'bug', 'test', 'unit test', 'refactor', 'feature', 'api', 'endpoint', 'function', 'class', 'module', 'component', 'deploy', 'ci', 'pipeline'],
  researcher: ['research', 'investigate', 'analyze', 'compare', 'find', 'discover', 'audit', 'review', 'survey', 'benchmark', 'evaluate', 'assess', 'competitor', 'market', 'trend'],
  reviewer: ['review', 'audit', 'check', 'verify', 'validate', 'quality', 'security', 'compliance', 'approve'],
  tester: ['test', 'qa', 'e2e', 'integration test', 'regression', 'coverage', 'verify', 'validate'],
  devops: ['deploy', 'infrastructure', 'ci', 'cd', 'docker', 'kubernetes', 'monitoring', 'pipeline', 'server', 'nginx', 'ssl'],
  assistant: ['write', 'draft', 'summarize', 'translate', 'format', 'document', 'docs', 'readme', 'email', 'message', 'report'],
  agent: [], // generic fallback
}

function scoreAgentForTask(
  agent: { name: string; role: string; status: string; config: string | null },
  taskText: string,
): number {
  // Offline agents can't take work
  if (agent.status === 'offline' || agent.status === 'error' || agent.status === 'sleeping') return -1

  const text = taskText.toLowerCase()
  const keywords = ROLE_AFFINITY[agent.role] || []

  let score = 0
  // Role keyword match
  for (const kw of keywords) {
    if (text.includes(kw)) score += 10
  }

  // Idle agents get a bonus (prefer agents not currently busy)
  if (agent.status === 'idle') score += 5

  // Check agent capabilities from config
  if (agent.config) {
    try {
      const cfg = JSON.parse(agent.config)
      const caps = Array.isArray(cfg.capabilities) ? cfg.capabilities : []
      for (const cap of caps) {
        if (typeof cap === 'string' && text.includes(cap.toLowerCase())) score += 15
      }
    } catch { /* ignore */ }
  }

  // Any non-offline agent gets at least 1 (can be a fallback)
  return Math.max(score, 1)
}

/**
 * Auto-route inbox tasks to the best available agent.
 * Runs before dispatch — moves tasks from inbox → assigned.
 */
export async function autoRouteInboxTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const inboxTasks = db.prepare(`
    SELECT id, title, description, priority, tags, workspace_id
    FROM tasks
    WHERE status = 'inbox' AND assigned_to IS NULL
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      created_at ASC
    LIMIT 5
  `).all() as Array<{ id: number; title: string; description: string | null; priority: string; tags: string | null; workspace_id: number }>

  if (inboxTasks.length === 0) {
    return { ok: true, message: 'No inbox tasks to route' }
  }

  // Get all non-hidden, non-offline agents
  const agents = db.prepare(`
    SELECT id, name, role, status, config
    FROM agents
    WHERE hidden = 0 AND status NOT IN ('offline', 'error')
    LIMIT 50
  `).all() as Array<{ id: number; name: string; role: string; status: string; config: string | null }>

  if (agents.length === 0) {
    return { ok: true, message: `${inboxTasks.length} inbox task(s) but no available agents` }
  }

  let routed = 0
  const now = Math.floor(Date.now() / 1000)

  for (const task of inboxTasks) {
    const taskText = `${task.title} ${task.description || ''}`
    let parsedTags: string[] = []
    if (task.tags) {
      try { parsedTags = JSON.parse(task.tags) } catch { /* ignore */ }
    }
    const fullText = `${taskText} ${parsedTags.join(' ')}`

    // Score each agent
    const scored = agents
      .map(a => ({ agent: a, score: scoreAgentForTask(a, fullText) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) continue

    const best = scored[0].agent

    // Check capacity — skip agents with 3+ in-progress tasks
    const inProgressCount = (db.prepare(
      'SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND status = \'in_progress\' AND workspace_id = ?'
    ).get(best.name, task.workspace_id) as { c: number }).c

    if (inProgressCount >= 3) {
      // Try next best agent
      const alt = scored.find(s => {
        const c = (db.prepare(
          'SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND status = \'in_progress\' AND workspace_id = ?'
        ).get(s.agent.name, task.workspace_id) as { c: number }).c
        return c < 3
      })
      if (!alt) continue // all agents at capacity
      db.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ?')
        .run('assigned', alt.agent.name, now, task.id)

      db_helpers.logActivity('task_auto_routed', 'task', task.id, 'scheduler',
        `Auto-assigned "${task.title}" to ${alt.agent.name} (${alt.agent.role}, score: ${alt.score})`,
        { agent: alt.agent.name, role: alt.agent.role, score: alt.score },
        task.workspace_id)

      eventBus.broadcast('task.status_changed', { id: task.id, status: 'assigned', previous_status: 'inbox', assigned_to: alt.agent.name })
      routed++
      continue
    }

    db.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ?')
      .run('assigned', best.name, now, task.id)

    db_helpers.logActivity('task_auto_routed', 'task', task.id, 'scheduler',
      `Auto-assigned "${task.title}" to ${best.name} (${best.role}, score: ${scored[0].score})`,
      { agent: best.name, role: best.role, score: scored[0].score },
      task.workspace_id)

    eventBus.broadcast('task.status_changed', { id: task.id, status: 'assigned', previous_status: 'inbox', assigned_to: best.name })
    routed++
  }

  return {
    ok: true,
    message: routed > 0
      ? `Auto-routed ${routed}/${inboxTasks.length} inbox task(s)`
      : `${inboxTasks.length} inbox task(s), no suitable agents found`,
  }
}
