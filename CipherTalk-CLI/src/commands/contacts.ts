import type { Command } from 'commander'
import { parseLimit } from '../config.js'
import { runCommand, type CommandContext } from '../commandRunner.js'

export function registerContactsCommand(program: Command, context: CommandContext): void {
  const contacts = program
    .command('contacts')
    .description('列出联系人')
    .option('--type <type>', 'friend | group | mp')
    .action(async () => {
      await runCommand(contacts, context, async (config, options) => {
        const limit = parseLimit((contacts.optsWithGlobals() as { limit?: string }).limit, config.defaultLimit)
        const result = await context.services.data.listContacts(config, {
          type: typeof options.type === 'string' ? options.type : undefined,
          limit
        })
        return { data: { contacts: result.contacts }, meta: { total: result.contacts.length, limit } }
      })
    })

  const info = contacts
    .command('info')
    .argument('<contact>', 'wxid or display name')
    .description('查看联系人详情')
    .action(async (contact: string) => {
      await runCommand(info, context, async (config) => {
        const info = await context.services.data.getContactInfo(config, contact)
        return { data: { contact: info }, meta: { total: info ? 1 : 0 } }
      })
    })
}
