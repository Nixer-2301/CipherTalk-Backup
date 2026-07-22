import { dialog, ipcMain } from 'electron'
import type { MainProcessContext } from '../context'
import { chatService } from '../../services/chatService'
import { isPrivateSession } from '../../services/notifyService'
import { petReminderService } from '../../services/petReminderService'
import {
  fetchPetManifest,
  getPetSpriteDataUrl,
  hasBuiltinPet,
  importPetZip,
  installPet,
  listInstalledPets,
  removePet,
} from '../../services/petService'

export function registerPetHandlers(ctx: MainProcessContext): void {
  const ensureDefaultPet = (): void => {
    const config = ctx.getConfigService()
    if (!config || config.get('petDefaultInitialized')) return

    if (!config.get('petCurrent') && hasBuiltinPet()) {
      config.set('petCurrent', 'miyuji')
      ctx.broadcastToWindows('config:changed', { key: 'petCurrent', value: 'miyuji' })
    }
    config.set('petDesktopEnabled', true)
    ctx.broadcastToWindows('config:changed', { key: 'petDesktopEnabled', value: true })
    config.set('petDefaultInitialized', true)
  }

  ensureDefaultPet()
  petReminderService.init(ctx)

  ipcMain.handle('pet:listInstalled', async () => {
    try {
      ensureDefaultPet()
      return { success: true, pets: listInstalledPets(ctx.getConfigService()) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('pet:manifest', async (_, force?: boolean) => {
    try {
      return { success: true, pets: await fetchPetManifest(Boolean(force)) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('pet:install', async (_, slug: string) => {
    try {
      return { success: true, pet: await installPet(slug, ctx.getConfigService()) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('pet:remove', async (_, slug: string) => {
    try {
      removePet(slug, ctx.getConfigService())
      const config = ctx.getConfigService()
      if (config?.get('petCurrent') === slug) {
        config.set('petCurrent', '')
        ctx.broadcastToWindows('config:changed', { key: 'petCurrent', value: '' })
      }
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 从本地压缩包导入宠物：弹文件选择框 → 解压校验 → 落到 cachePath/pets/
  ipcMain.handle('pet:importZip', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择宠物压缩包',
      properties: ['openFile'],
      filters: [{ name: '宠物压缩包', extensions: ['zip'] }],
    })
    const zipPath = result.filePaths[0]
    if (result.canceled || !zipPath) return { success: false, canceled: true }
    try {
      return { success: true, pet: importPetZip(zipPath, ctx.getConfigService()) }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('pet:getSprite', async (_, slug: string) => {
    const dataUrl = getPetSpriteDataUrl(slug, ctx.getConfigService())
    return dataUrl ? { success: true, dataUrl } : { success: false, error: '宠物精灵图不存在' }
  })

  // Agent 运行状态：渲染进程上报，转发给所有窗口（桌宠窗口据此切动画）
  ipcMain.on('pet:agentState', (_, state: string) => {
    ctx.broadcastToWindows('pet:agentState', state)
  })

  // Agent 运行进度：AgentPage 上报可见进度，桌宠窗口显示瞬态进度气泡
  ipcMain.on('pet:agentProgress', (_, progress: { stage: string; title: string; detail?: string }) => {
    ctx.broadcastToWindows('pet:agentProgress', progress)
  })

  // 每日摘要：桌宠窗口轮询请求，每天只生成一次（petDailySummaryDate 防重）。
  // 统计口径只读 Session 表前 200 条（与 notifyService 同思路），不扫消息库。
  ipcMain.handle('pet:getDailySummary', async () => {
    try {
      const config = ctx.getConfigService()
      if (!config || config.get('petDailySummaryEnabled') === false) return { success: false }
      const now = new Date()
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      if (config.get('petDailySummaryDate') === todayKey) return { success: false }

      const result = await chatService.getSessions(0, 200)
      if (!result.success || !Array.isArray(result.sessions) || result.sessions.length === 0) {
        return { success: false } // 库没连上/没数据：不记日期，之后重试
      }

      const startOfToday = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000)
      const startOfYesterday = startOfToday - 86400
      const privateSessions = result.sessions.filter(isPrivateSession)
      const yesterdayNames: string[] = []
      let unreadTotal = 0
      for (const session of privateSessions) {
        const ts = Number(session.lastTimestamp || session.sortTimestamp || 0)
        if (ts >= startOfYesterday && ts < startOfToday) {
          yesterdayNames.push(session.displayName || session.username)
        }
        unreadTotal += Math.max(0, Number(session.unreadCount || 0))
      }

      const parts: string[] = []
      if (yesterdayNames.length > 0) {
        const shown = yesterdayNames.slice(0, 3).join('、')
        parts.push(`昨天有 ${yesterdayNames.length} 位好友给你发来消息：${shown}${yesterdayNames.length > 3 ? ' 等' : ''}。`)
      } else {
        parts.push('昨天没有好友发来新消息。')
      }
      if (unreadTotal > 0) parts.push(`当前还有 ${unreadTotal} 条未读私聊。`)

      config.set('petDailySummaryDate', todayKey)
      return { success: true, text: parts.join(' ') }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // 桌宠窗口请求扩窗/还原以容纳消息提醒气泡
  ipcMain.on('pet:setBubble', (_, expanded: boolean) => {
    ctx.getWindowManager().setPetBubbleExpanded(Boolean(expanded))
  })

  ipcMain.on('pet:showContextMenu', () => {
    ctx.getWindowManager().showPetContextMenu()
  })

  // 桌宠手动拖拽：dragStart 记录窗口原点，dragMove 传按下点起算的累计位移
  ipcMain.on('pet:dragStart', () => {
    ctx.getWindowManager().petDragStart()
  })

  ipcMain.on('pet:dragMove', (_, dx: number, dy: number) => {
    ctx.getWindowManager().petDragMove(Number(dx), Number(dy))
  })

  // 松手：解除拖拽冻结并统一应用气泡扩窗/还原（含放大态自愈）
  ipcMain.on('pet:dragEnd', () => {
    ctx.getWindowManager().petDragEnd()
  })

  ipcMain.handle('pet:toggleDesktopWindow', async (_, enabled: boolean) => {
    const manager = ctx.getWindowManager()
    if (enabled) manager.openPetWindow()
    else manager.closePetWindow()
    ctx.getConfigService()?.set('petDesktopEnabled', enabled)
    ctx.broadcastToWindows('config:changed', { key: 'petDesktopEnabled', value: enabled })
    return { success: true }
  })
}
