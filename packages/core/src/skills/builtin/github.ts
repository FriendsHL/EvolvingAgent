import type { ExecutableSkill, SkillContext, SkillResult } from '../../types.js'

/**
 * Skill: github
 * Interact with GitHub via the `gh` CLI — list issues, view PRs, create issues, search repos.
 */
export const githubSkill: ExecutableSkill = {
  id: 'github',
  name: 'GitHub',
  description: 'Interact with GitHub: list issues, view PRs, create issues, search repos',
  category: 'builtin',
  triggers: ['github', 'issue', 'pull request', 'pr', 'repo', '仓库', '问题'],
  inputs: [
    { name: 'action', description: 'Action: list-issues, get-issue, get-pr, create-issue, search', type: 'string', required: true },
    { name: 'repo', description: 'Repository (owner/repo)', type: 'string', required: false },
    { name: 'query', description: 'Search query or issue number', type: 'string', required: false },
    { name: 'title', description: 'Issue title (for create-issue)', type: 'string', required: false },
    { name: 'body', description: 'Issue body (for create-issue)', type: 'string', required: false },
  ],

  async execute(params, ctx: SkillContext): Promise<SkillResult> {
    const action = params.action as string
    if (!action) return { success: false, output: '', error: 'action is required' }

    // Check if gh CLI is available
    const checkResult = await ctx.useTool('shell', { command: 'which gh 2>/dev/null || echo __NOT_FOUND__' })
    if (!checkResult.success || checkResult.output.includes('__NOT_FOUND__')) {
      return {
        success: false,
        output: '',
        error: 'GitHub CLI (gh) is not installed. Install it from https://cli.github.com/',
      }
    }

    const repo = params.repo as string | undefined
    const query = params.query as string | undefined

    switch (action) {
      case 'list-issues': {
        if (!repo) return { success: false, output: '', error: 'repo is required for list-issues' }
        ctx.emit(`Listing issues for ${repo}...`)
        const result = await ctx.useTool('shell', {
          command: `gh issue list --repo ${repo} --limit 10`,
        })
        if (!result.success) {
          return { success: false, output: '', error: `Failed to list issues: ${result.error}` }
        }
        return { success: true, output: result.output, data: { action, repo } }
      }

      case 'get-issue': {
        if (!repo) return { success: false, output: '', error: 'repo is required for get-issue' }
        if (!query) return { success: false, output: '', error: 'query (issue number) is required for get-issue' }
        ctx.emit(`Fetching issue #${query} from ${repo}...`)
        const result = await ctx.useTool('shell', {
          command: `gh issue view ${query} --repo ${repo}`,
        })
        if (!result.success) {
          return { success: false, output: '', error: `Failed to get issue: ${result.error}` }
        }
        return { success: true, output: result.output, data: { action, repo, issue: query } }
      }

      case 'get-pr': {
        if (!repo) return { success: false, output: '', error: 'repo is required for get-pr' }
        if (!query) return { success: false, output: '', error: 'query (PR number) is required for get-pr' }
        ctx.emit(`Fetching PR #${query} from ${repo}...`)
        const result = await ctx.useTool('shell', {
          command: `gh pr view ${query} --repo ${repo}`,
        })
        if (!result.success) {
          return { success: false, output: '', error: `Failed to get PR: ${result.error}` }
        }
        return { success: true, output: result.output, data: { action, repo, pr: query } }
      }

      case 'create-issue': {
        if (!repo) return { success: false, output: '', error: 'repo is required for create-issue' }
        const title = params.title as string
        const body = params.body as string | undefined
        if (!title) return { success: false, output: '', error: 'title is required for create-issue' }
        ctx.emit(`Creating issue in ${repo}: ${title}`)
        const bodyFlag = body ? ` --body ${JSON.stringify(body)}` : ''
        const result = await ctx.useTool('shell', {
          command: `gh issue create --repo ${repo} --title ${JSON.stringify(title)}${bodyFlag}`,
        })
        if (!result.success) {
          return { success: false, output: '', error: `Failed to create issue: ${result.error}` }
        }
        return { success: true, output: result.output, data: { action, repo, title } }
      }

      case 'search': {
        if (!query) return { success: false, output: '', error: 'query is required for search' }
        ctx.emit(`Searching GitHub repos: ${query}`)
        const result = await ctx.useTool('shell', {
          command: `gh search repos ${JSON.stringify(query)} --limit 5`,
        })
        if (!result.success) {
          return { success: false, output: '', error: `Search failed: ${result.error}` }
        }
        return { success: true, output: result.output, data: { action, query } }
      }

      default:
        return {
          success: false,
          output: '',
          error: `Unknown action: ${action}. Supported: list-issues, get-issue, get-pr, create-issue, search`,
        }
    }
  },
}
