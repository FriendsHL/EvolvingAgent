/**
 * English locale dictionary.
 *
 * Keys are dot-namespaced by surface (sidebar.*, chat.*, sessions.*).
 * Missing keys fall back to either the explicit `t(key, fallback)` second
 * arg or the key itself, so partial coverage is fine.
 */
export const en = {
  // Sidebar / nav
  'sidebar.brand': 'Evolving Agent',
  'sidebar.subtitle': 'Admin Dashboard',
  'sidebar.chat': 'Chat',
  'sidebar.events': 'Events',
  'sidebar.dashboard': 'Dashboard',
  'sidebar.agents': 'Agents',
  'sidebar.sessions': 'Sessions',
  'sidebar.skills': 'Skills',
  'sidebar.tools': 'Tools',
  'sidebar.mcp': 'MCP',
  'sidebar.prompts': 'Prompts',
  'sidebar.optimization': 'Optimization',
  'sidebar.coordinate': 'Coordinate',
  'sidebar.memory': 'Memory',
  'sidebar.hooks': 'Hooks',
  'sidebar.metrics': 'Metrics',
  'sidebar.settings': 'Settings',

  // Header
  'header.title': 'Evolving Agent Control Panel',
  'header.connected': 'Connected',
  'header.language': 'Language',
  'header.language.en': 'English',
  'header.language.zh': '中文',

  // Common
  'common.loading': 'Loading…',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.create': 'Create',
  'common.refresh': 'Refresh',
  'common.send': 'Send',
  'common.error': 'Error',
  'common.empty': 'No data',

  // Chat page
  'chat.title': 'Chat',
  'chat.messages': '{count} messages',
  'chat.empty': 'No messages yet. Start the conversation below.',
  'chat.loadingHistory': 'Loading history…',
  'chat.input.placeholder': 'Type a message... (Enter to send, Shift+Enter for newline)',
  'chat.preview': 'Preview',
  'chat.preview.title': 'Prompt preview',
  'chat.preview.subtitle': 'Conversational view — what {provider} ({model}) will see',
  'chat.preview.empty': 'Loading…',
  'chat.preview.footer': '{count} messages · {chars} chars · {turns} history turns',
  'chat.edit.tooltip': 'Edit this message and re-run from here',
  'chat.edit.save': 'Save & re-run',
  'chat.feedback.helpful': 'Helpful',
  'chat.feedback.notHelpful': 'Not helpful',
  'chat.feedback.thanks': 'Thanks for the feedback',

  // Sessions page
  'sessions.title': 'Sessions',
  'sessions.col.title': 'Title',
  'sessions.col.id': 'ID',
  'sessions.col.created': 'Created',
  'sessions.col.lastActive': 'Last active',
  'sessions.col.messages': 'Messages',
  'sessions.empty': 'No sessions recorded yet',
  'sessions.untitled': '(untitled)',

  // Settings page
  'settings.title': 'Settings',
  'settings.budget.title': 'Budget',
  'settings.language.title': 'Language',
  'settings.language.help': 'Choose the dashboard interface language. Saved locally in your browser.',
} as const

export type TranslationKey = keyof typeof en
