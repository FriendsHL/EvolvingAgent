#!/usr/bin/env node

import { Command } from 'commander'
import { chatCommand } from './commands/chat.js'
import { memoryCommand } from './commands/memory.js'
import { statsCommand } from './commands/stats.js'

const program = new Command()

program
  .name('evolving-agent')
  .description('Self-evolving AI Agent that learns from every interaction')
  .version('0.1.0')

program
  .command('chat')
  .description('Start an interactive conversation with the agent')
  .action(chatCommand)

program
  .command('memory')
  .description('View stored experiences and memory state')
  .action(memoryCommand)

program
  .command('stats')
  .description('Show token usage and cost statistics')
  .option('-d, --date <date>', 'Date to show stats for (YYYY-MM-DD)')
  .action(statsCommand)

// Default to chat if no command specified
program.action(chatCommand)

program.parse()
