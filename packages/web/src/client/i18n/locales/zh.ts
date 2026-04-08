/**
 * 简体中文 locale dictionary.
 *
 * 任何缺失的 key 会回退到 en.ts 里的值,所以增量翻译是安全的。
 */
import type { TranslationKey } from './en.js'

export const zh: Partial<Record<TranslationKey, string>> = {
  // Sidebar / nav
  'sidebar.brand': 'Evolving Agent',
  'sidebar.subtitle': '管理后台',
  'sidebar.chat': '对话',
  'sidebar.events': '事件流',
  'sidebar.dashboard': '仪表盘',
  'sidebar.agents': '智能体',
  'sidebar.sessions': '会话',
  'sidebar.skills': '技能',
  'sidebar.tools': '工具',
  'sidebar.mcp': 'MCP',
  'sidebar.prompts': '提示词',
  'sidebar.optimization': '优化中心',
  'sidebar.coordinate': '协同',
  'sidebar.memory': '记忆',
  'sidebar.hooks': '钩子',
  'sidebar.metrics': '指标',
  'sidebar.settings': '设置',

  // Header
  'header.title': 'Evolving Agent 控制台',
  'header.connected': '已连接',
  'header.language': '语言',
  'header.language.en': 'English',
  'header.language.zh': '中文',

  // Common
  'common.loading': '加载中…',
  'common.save': '保存',
  'common.cancel': '取消',
  'common.delete': '删除',
  'common.create': '新建',
  'common.refresh': '刷新',
  'common.send': '发送',
  'common.error': '错误',
  'common.empty': '暂无数据',

  // Chat page
  'chat.title': '对话',
  'chat.messages': '共 {count} 条消息',
  'chat.empty': '暂无消息,请在下方开始对话。',
  'chat.loadingHistory': '正在加载历史…',
  'chat.input.placeholder': '输入消息……(Enter 发送,Shift+Enter 换行)',
  'chat.preview': '预览',
  'chat.preview.title': '提示词预览',
  'chat.preview.subtitle': '对话视图 — {provider}({model})实际会看到的内容',
  'chat.preview.empty': '加载中…',
  'chat.preview.footer': '{count} 条消息 · {chars} 字符 · {turns} 轮历史',
  'chat.edit.tooltip': '编辑这条消息并从此处重跑',
  'chat.edit.save': '保存并重跑',
  'chat.feedback.helpful': '有帮助',
  'chat.feedback.notHelpful': '没帮助',
  'chat.feedback.thanks': '感谢反馈',

  // Sessions page
  'sessions.title': '会话',
  'sessions.col.title': '标题',
  'sessions.col.id': 'ID',
  'sessions.col.created': '创建时间',
  'sessions.col.lastActive': '最近活跃',
  'sessions.col.messages': '消息数',
  'sessions.empty': '暂无会话记录',
  'sessions.untitled': '(未命名)',

  // Settings page
  'settings.title': '设置',
  'settings.budget.title': '预算',
  'settings.language.title': '语言',
  'settings.language.help': '选择面板的界面语言,设置会保存在浏览器本地。',
}
