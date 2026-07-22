import { describe, expect, it } from 'vitest'
import { getInteractiveCommands, needsCompletion } from '../../src/interactiveShell.js'

describe('needsCompletion', () => {
  const byName = (name: string) => getInteractiveCommands().find((c) => c.name === name)!

  it('无参命令（数字选中后直接执行）返回 false', () => {
    for (const name of ['/status', '/config', '/sessions', '/contacts', '/moments', '/help', '/exit']) {
      expect(needsCompletion(byName(name)), name).toBe(false)
    }
  })

  it('需要必填参数的命令（数字选中后填入等补全）返回 true', () => {
    for (const name of ['/messages', '/contact', '/search', '/export', '/key', '/mcp']) {
      expect(needsCompletion(byName(name)), name).toBe(true)
    }
  })
})
