import { describe, expect, it } from 'vitest'

import {
  buildAegisReviewComment,
  buildDispatchFailureComment,
  buildDispatchFailureNotificationMessage,
  buildDispatchFailureNotificationTitle,
  hasBlockingWorkspaceChanges,
  buildReworkPrompt,
  buildTaskPrompt,
  getTaskBaseBranch,
  parsePullRequestReference,
  shouldAwaitPrBeforeReview,
} from '@/lib/task-dispatch'

describe('shouldAwaitPrBeforeReview', () => {
  it('returns true when async dispatch metadata includes a pr_file', () => {
    expect(shouldAwaitPrBeforeReview({ pr_file: '/tmp/mc-task-42.pr' })).toBe(true)
  })

  it('returns false when no pr_file is present', () => {
    expect(shouldAwaitPrBeforeReview({ dispatch_session_id: 'mc-task-42' })).toBe(false)
    expect(shouldAwaitPrBeforeReview(null)).toBe(false)
  })
})

describe('getTaskBaseBranch', () => {
  it('defaults to dev when the project has no configured base branch', () => {
    expect(getTaskBaseBranch({ github_default_branch: null })).toBe('dev')
  })

  it('treats legacy main configuration as dev', () => {
    expect(getTaskBaseBranch({ github_default_branch: 'main' })).toBe('dev')
  })

  it('uses the configured project base branch when present', () => {
    expect(getTaskBaseBranch({ github_default_branch: 'release' })).toBe('release')
  })
})

describe('hasBlockingWorkspaceChanges', () => {
  it('ignores untracked .openclaw artifacts', () => {
    expect(hasBlockingWorkspaceChanges('?? .openclaw/\n')).toBe(false)
    expect(hasBlockingWorkspaceChanges('?? .openclaw/session/log.json\n')).toBe(false)
  })

  it('still blocks on real repository changes', () => {
    expect(hasBlockingWorkspaceChanges(' M src/app.ts\n')).toBe(true)
    expect(hasBlockingWorkspaceChanges('?? src/new-file.ts\n')).toBe(true)
    expect(hasBlockingWorkspaceChanges('?? .openclaw/\n M src/app.ts\n')).toBe(true)
  })
})

describe('buildTaskPrompt', () => {
  it('requires resetting to dev and opening the PR against dev by default', () => {
    const prompt = buildTaskPrompt({
      id: 42,
      title: 'Fix login redirect',
      description: null,
      status: 'assigned',
      priority: 'high',
      assigned_to: 'codex',
      workspace_id: 1,
      agent_name: 'codex',
      agent_id: 1,
      agent_config: null,
      ticket_prefix: null,
      project_ticket_no: null,
      project_id: null,
      github_default_branch: null,
    })

    expect(prompt).toContain('git checkout dev')
    expect(prompt).toContain('git fetch origin dev && git reset --hard origin/dev')
    expect(prompt).toContain('Create your task branch from dev')
    expect(prompt).toContain('gh pr create --base dev')
  })

  it('uses the configured base branch in the PR workflow instructions', () => {
    const prompt = buildTaskPrompt({
      id: 7,
      title: 'Ship hotfix',
      description: null,
      status: 'assigned',
      priority: 'medium',
      assigned_to: 'codex',
      workspace_id: 1,
      agent_name: 'codex',
      agent_id: 1,
      agent_config: null,
      ticket_prefix: 'OPS',
      project_ticket_no: 12,
      project_id: 3,
      github_default_branch: 'staging',
    })

    expect(prompt).toContain('git checkout staging')
    expect(prompt).toContain('git fetch origin staging && git reset --hard origin/staging')
    expect(prompt).toContain('gh pr create --base staging')
  })
})

describe('parsePullRequestReference', () => {
  it('extracts repo and PR number from a GitHub PR URL', () => {
    expect(parsePullRequestReference('https://github.com/acme/app/pull/96')).toEqual({
      repo: 'acme/app',
      pullNumber: 96,
    })
  })

  it('returns null for non-PR URLs', () => {
    expect(parsePullRequestReference('https://github.com/acme/app/issues/96')).toBeNull()
  })
})

describe('review follow-up prompts', () => {
  it('formats an Aegis review comment as an operational review record', () => {
    expect(buildAegisReviewComment('approved', 'Looks good', 'https://github.com/acme/app/pull/96')).toContain('Aegis Review: APPROVED')
  })

  it('tells the developer to update the same PR on rework', () => {
    const prompt = buildReworkPrompt({
      id: 9,
      title: 'Fix login button',
      description: null,
      resolution: null,
      assigned_to: 'codex',
      agent_config: null,
      workspace_id: 1,
      ticket_prefix: null,
      project_ticket_no: null,
      metadata: null,
      github_repo: 'acme/app',
      dispatch_attempts: 1,
    }, 'Change the color token', 'https://github.com/acme/app/pull/96')

    expect(prompt).toContain('Do not open a new PR')
    expect(prompt).toContain('/tmp/mc-task-9.pr')
  })
})

describe('dispatch failure surfacing', () => {
  it('formats a notification title with the task reference', () => {
    expect(buildDispatchFailureNotificationTitle({
      id: 12,
      title: 'Fix sync loop',
      ticket_prefix: 'OPS',
      project_ticket_no: 7,
    })).toBe('Dispatch failed for [OPS-007] Fix sync loop')
  })

  it('includes workspace, branch, and retry state in the notification message', () => {
    const message = buildDispatchFailureNotificationMessage(
      {
        id: 12,
        title: 'Fix sync loop',
        ticket_prefix: null,
        project_ticket_no: null,
      },
      'Command failed (git fetch origin dev): network down',
      'dev',
      '/root/things/profitstack-next',
      2,
      5,
    )

    expect(message).toContain('Dispatch retry 2/5 failed.')
    expect(message).toContain('Base branch: dev.')
    expect(message).toContain('Workspace: /root/things/profitstack-next.')
    expect(message).toContain('network down')
  })

  it('formats a persistent task comment for terminal dispatch failures', () => {
    const comment = buildDispatchFailureComment(
      {
        id: 12,
        title: 'Fix sync loop',
        ticket_prefix: null,
        project_ticket_no: null,
      },
      'Command failed (git reset --hard origin/dev): permission denied',
      'dev',
      '/root/things/profitstack-next',
      5,
      5,
    )

    expect(comment).toContain('Dispatch error for [TASK-12] Fix sync loop')
    expect(comment).toContain('Dispatch permanently failed after 5/5 attempts.')
    expect(comment).toContain('Base branch: dev')
    expect(comment).toContain('Workspace: /root/things/profitstack-next')
    expect(comment).toContain('permission denied')
  })
})
