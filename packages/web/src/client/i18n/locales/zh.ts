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

  // Chat rename
  'chat.rename.prompt': '重命名会话',

  // Optimization page
  'optimization.title': '优化中心',
  'optimization.subtitle': '集中查看提示词自优化与经验蒸馏。在这里发起新的任务,接受/拒绝结果需要到各自专页。',
  'optimization.promptRuns': 'Prompt 优化',
  'optimization.distillRuns': '经验蒸馏',
  'optimization.pending': '待审核',
  'optimization.pending.subtitle': '等待人工接受',
  'optimization.total': '总运行数',
  'optimization.stats.subtitle': '{running} 进行中 · {completed} 已完成 · {failed} 失败',
  'optimization.timeline.title': '运行时间线',
  'optimization.timeline.empty': '还没有任何优化运行,先在上方触发一个。',
  'optimization.prompt.title': '优化一个 Prompt',
  'optimization.prompt.target': '目标',
  'optimization.prompt.count': '候选数',
  'optimization.prompt.launch': '启动优化运行',
  'optimization.prompt.launching': '启动中…',
  'optimization.distill.title': '蒸馏经验',
  'optimization.distill.maxInputs': '最多样本',
  'optimization.distill.maxLessons': '最多课程',
  'optimization.distill.launch': '运行蒸馏',
  'optimization.distill.launching': '运行中…',
  'optimization.help.intro': '这个页面做什么:优化主 Agent 使用的 3 类提示词(planner / conversational / reflector),以及把历史经验蒸馏成可复用的课程。Prompt 正文在"提示词"页查看编辑;评测用例在 `data/eval/cases`。',
}
