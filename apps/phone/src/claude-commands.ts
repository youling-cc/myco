/**
 * claude code TUI 常用斜杠命令（手机命令面板用）。
 * 本机/仓库均无现成清单（Explore 确认），手机端本地维护。
 * 点选 = transport.input(cmd + '\n')，走正常文本注入，不需新协议。
 * 不含用户自定义 ~/.claude/commands/* 和 plugin 命令（那些命令面板看不到全貌，用户手敲）。
 */
export interface ClaudeCmd {
  cmd: string
  desc: string
  group: string
}

export const CLAUDE_COMMANDS: ClaudeCmd[] = [
  // 会话
  { cmd: '/clear', desc: '清空当前对话', group: '会话' },
  { cmd: '/compact', desc: '压缩上下文（省 token）', group: '会话' },
  { cmd: '/resume', desc: '恢复历史会话', group: '会话' },
  { cmd: '/rewind', desc: '回退到某条消息', group: '会话' },
  // 信息
  { cmd: '/context', desc: '看上下文用量', group: '信息' },
  { cmd: '/cost', desc: '看本次费用 / token', group: '信息' },
  { cmd: '/status', desc: '看当前状态', group: '信息' },
  { cmd: '/help', desc: '帮助', group: '信息' },
  // 配置
  { cmd: '/model', desc: '切换模型', group: '配置' },
  { cmd: '/config', desc: '配置项', group: '配置' },
  { cmd: '/permissions', desc: '权限设置', group: '配置' },
  { cmd: '/memory', desc: '记忆文件', group: '配置' },
  // 工具
  { cmd: '/agents', desc: '管理子代理', group: '工具' },
  { cmd: '/mcp', desc: 'MCP 服务器', group: '工具' },
  { cmd: '/init', desc: '初始化项目 CLAUDE.md', group: '工具' },
  { cmd: '/review', desc: '代码审查', group: '工具' },
  { cmd: '/vim', desc: 'vim 编辑模式', group: '工具' },
]
