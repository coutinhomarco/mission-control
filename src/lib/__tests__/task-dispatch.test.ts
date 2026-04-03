import { describe, expect, it } from 'vitest'

import {
  buildAegisReviewComment,
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

  it('uses the configured project base branch when present', () => {
    expect(getTaskBaseBranch({ github_default_branch: 'release' })).toBe('release')
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
    expect(prompt).toContain('git pull --ff-only origin dev')
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
    expect(prompt).toContain('git pull --ff-only origin staging')
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
