import { ipcMain } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { dbPathService } from '../../services/dbPathService'
import { wcdbService } from '../../services/wcdbService'
import { wxKeyService } from '../../services/wxKeyService'
import { wxKeyServiceMac } from '../../services/wxKeyServiceMac'
import type { MainProcessContext } from '../context'

/**
 * 微信密钥获取 IPC。
 * macOS 和 Windows 流程不同，wxkey:status 是前端步骤提示依赖的进度事件。
 */
export function registerWxKeyHandlers(ctx: MainProcessContext): void {
  ipcMain.handle('wxkey:isWeChatRunning', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.isWeChatRunning()
    }
    return wxKeyService.isWeChatRunning()
  })

  ipcMain.handle('wxkey:getWeChatPid', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.getWeChatPid()
    }
    return wxKeyService.getWeChatPid()
  })

  ipcMain.handle('wxkey:killWeChat', async () => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.killWeChat()
    }
    return wxKeyService.killWeChat()
  })

  ipcMain.handle('wxkey:launchWeChat', async (_, customWechatPath?: string) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.launchWeChat(customWechatPath)
    }
    return wxKeyService.launchWeChat(customWechatPath)
  })

  ipcMain.handle('wxkey:waitForWindow', async (_, maxWaitSeconds?: number) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.waitForWeChatWindow(maxWaitSeconds)
    }
    return wxKeyService.waitForWeChatWindow(maxWaitSeconds)
  })

  ipcMain.handle('wxkey:startGetKey', async (event, customWechatPath?: string, dbPath?: string) => {
    ctx.getLogService()?.info('WxKey', '开始获取微信密钥', { customWechatPath })
    if (process.platform === 'darwin') {
      try {
        const isRunning = wxKeyServiceMac.isWeChatRunning()
        if (isRunning) {
          event.sender.send('wxkey:status', { status: '检测到微信正在运行，正在关闭微信...', level: 0 })
          wxKeyServiceMac.killWeChat()

          const exited = await wxKeyServiceMac.waitForWeChatExit(20)
          if (!exited) {
            return { success: false, error: '未能自动关闭微信，请先手动退出微信后重试' }
          }

          event.sender.send('wxkey:status', { status: '微信已关闭，正在重新启动微信...', level: 0 })
          const relaunched = await wxKeyServiceMac.launchWeChat(customWechatPath)
          if (!relaunched) {
            return { success: false, error: '微信关闭后自动重启失败' }
          }

          event.sender.send('wxkey:status', { status: '微信已重新启动，等待主进程就绪...', level: 0 })
          const ready = await wxKeyServiceMac.waitForWeChatWindow(20)
          if (!ready) {
            return { success: false, error: '微信已重新启动，但未检测到可用主进程，请确认微信已完成启动并显示主窗口' }
          }
        } else {
          event.sender.send('wxkey:status', { status: '未检测到微信主进程，正在尝试启动微信...', level: 0 })

          const launched = await wxKeyServiceMac.launchWeChat(customWechatPath)
          if (!launched) {
            return { success: false, error: '未找到微信主进程，且自动启动微信失败' }
          }

          event.sender.send('wxkey:status', { status: '微信已启动，等待主进程就绪...', level: 0 })
          const ready = await wxKeyServiceMac.waitForWeChatWindow(20)
          if (!ready) {
            return { success: false, error: '微信已启动，但未检测到可用主进程，请确认微信已完成启动并显示主窗口' }
          }
        }

        const result = await wxKeyServiceMac.autoGetDbKey(180_000, (status, level) => {
          event.sender.send('wxkey:status', { status, level })
        })

        if (!result.success) {
          ctx.getLogService()?.warn('WxKey', 'macOS 数据库密钥获取失败', { error: result.error })
          return result
        }

        if (result.key && dbPath) {
          event.sender.send('wxkey:status', { status: '已获取候选密钥，正在验证数据库...', level: 0 })

          const wxidCandidates: string[] = []
          const pushWxid = (value?: string | null) => {
            const wxid = String(value || '').trim()
            if (!wxid || wxidCandidates.includes(wxid)) return
            wxidCandidates.push(wxid)
          }

          let currentAccount = wxKeyServiceMac.detectCurrentAccount(dbPath, 10)
          if (!currentAccount) {
            currentAccount = wxKeyServiceMac.detectCurrentAccount(dbPath, 60)
          }
          pushWxid(currentAccount?.wxid)

          try {
            const scannedWxids = dbPathService.scanWxids(dbPath)
            for (const wxid of scannedWxids) {
              pushWxid(wxid)
            }
          } catch {
            // ignore
          }

          let validatedWxid = ''
          let lastError = ''
          for (const wxid of wxidCandidates) {
            event.sender.send('wxkey:status', { status: `正在验证账号目录: ${wxid}`, level: 0 })
            const testResult = await wcdbService.testConnection(dbPath, result.key, wxid)
            if (testResult.success) {
              validatedWxid = wxid
              break
            }
            lastError = testResult.error || ''
          }

          if (!validatedWxid) {
            ctx.getLogService()?.warn('WxKey', 'macOS 候选密钥未通过数据库验证', {
              dbPath,
              candidateCount: wxidCandidates.length
            })
            return {
              success: false,
              error: lastError || '已捕获到候选密钥，但未通过数据库验证。请在微信完成登录后进入任意聊天，让数据库访问真正触发，再重试。'
            }
          }

          ctx.getLogService()?.info('WxKey', 'macOS 候选密钥已通过数据库验证', { dbPath, wxid: validatedWxid })
          return {
            ...result,
            validatedWxid
          }
        }

        ctx.getLogService()?.info('WxKey', 'macOS 数据库密钥获取成功', { keyLength: result.key?.length || 0 })
        return result
      } catch (e) {
        wxKeyServiceMac.dispose()
        ctx.getLogService()?.error('WxKey', 'macOS 获取密钥异常', { error: String(e) })
        return { success: false, error: String(e) }
      }
    }

    try {
      const safeScanWxids = (root: string): string[] => {
        try {
          return dbPathService.scanWxids(root)
        } catch {
          return []
        }
      }

      // DLL 返回的是“干净 wxid”（wxid_7r9dov5f7mse12），而真实账号目录名带后缀
      // （wxid_7r9dov5f7mse12_bf70）。全 app 的 wxid 字段约定为目录名，故按前缀解析出真实目录。
      const resolveAccountDir = (root: string, cleanWxid: string): string => {
        if (!cleanWxid) return ''
        const dirs = safeScanWxids(root)
        return (
          dirs.find(d => d === cleanWxid) ||
          dirs.find(d => d.startsWith(cleanWxid + '_')) ||
          dirs.find(d => d.startsWith(cleanWxid)) ||
          ''
        )
      }

      // 首选方案：对已登录、正在运行的微信直接扫内存（global_config 结构游走），
      // 一次性提取 db_key + 账号字段（wxid/昵称/微信号/手机号），无需退出重登。
      if (wxKeyService.isWeChatRunning()) {
        event.sender.send('wxkey:status', { status: '检测到微信正在运行，正在直接读取账号信息...', level: 1 })
        const account = wxKeyService.scanAccount()
        if (account?.dbKey) {
          // 把干净 wxid 解析成真实目录名，作为 app 内统一使用的 wxid（路径都按它拼）。
          const resolvedDir = dbPath ? resolveAccountDir(dbPath, account.wxid) : ''
          const bindWxid = resolvedDir || account.wxid
          const outAccount = { ...account, wxid: bindWxid }
          // 有数据库目录时做一次目录验证；拿到 dbKey 本身已通过 UUIDv4 自校验，
          // 即使无目录/未通过验证也直接返回密钥与账号信息。
          if (dbPath) {
            const accWxids = bindWxid
              ? [bindWxid, ...safeScanWxids(dbPath).filter(w => w !== bindWxid)]
              : safeScanWxids(dbPath)
            for (const wxid of accWxids) {
              event.sender.send('wxkey:status', { status: `已读取账号信息，正在验证: ${account.name || wxid}`, level: 1 })
              const testResult = await wcdbService.testConnection(dbPath, account.dbKey, wxid)
              if (testResult.success) {
                ctx.getLogService()?.info('WxKey', '直接读取账号信息成功（无需重启微信）', {
                  wxid, hasName: !!account.name, hasNumber: !!account.number, hasPhone: !!account.phone
                })
                return { success: true, key: account.dbKey, validatedWxid: wxid, account: { ...account, wxid } }
              }
            }
          }
          // 未做/未通过目录验证：不回填 validatedWxid（前端据此标记为“未验证”），
          // 但仍带回解析后的目录名供前端自动绑定目录。
          ctx.getLogService()?.info('WxKey', '直接读取到账号信息（未通过目录验证），返回密钥与账号', { bindWxid })
          return { success: true, key: account.dbKey, account: outAccount }
        }
        ctx.getLogService()?.info('WxKey', '直接读取未命中，回退到重启微信抓取流程')
      }

      // 回退方案：重启微信，在其启动加载密钥的瞬间扫描 crypt_key 邻域。
      // 关闭已运行的微信，确保走一次完整的密钥加载。
      if (wxKeyService.isWeChatRunning()) {
        ctx.getLogService()?.info('WxKey', '检测到微信正在运行，准备关闭')
        event.sender.send('wxkey:status', { status: '检测到微信正在运行，准备关闭...', level: 1 })
        wxKeyService.killWeChat()
        await new Promise(resolve => setTimeout(resolve, 2000))
      }

      // 获取微信路径
      const wechatPath = customWechatPath || wxKeyService.getWeChatPath()
      if (!wechatPath) {
        ctx.getLogService()?.error('WxKey', '未找到微信安装路径')
        return { success: false, error: '未找到微信安装路径', needManualPath: true }
      }

      ctx.getLogService()?.info('WxKey', '找到微信路径', { wechatPath })
      event.sender.send('wxkey:status', { status: '正在启动微信...', level: 1 })

      // 启动微信
      const launchSuccess = await wxKeyService.launchWeChat(customWechatPath)
      if (!launchSuccess) {
        ctx.getLogService()?.error('WxKey', '启动微信失败')
        return { success: false, error: '启动微信失败' }
      }

      // 等待微信进程出现
      event.sender.send('wxkey:status', { status: '等待微信进程启动...', level: 1 })
      const windowAppeared = await wxKeyService.waitForWeChatWindow(15)
      if (!windowAppeared) {
        ctx.getLogService()?.error('WxKey', '微信进程启动超时')
        return { success: false, error: '微信进程启动超时' }
      }

      // 解析候选账号目录，定位 contact.db（决定校验用的 salt）
      if (!dbPath) {
        return { success: false, error: '缺少数据库路径，无法定位 contact.db' }
      }
      const wxids: string[] = []
      const pushWxid = (value?: string | null) => {
        const wxid = String(value || '').trim()
        if (wxid && !wxids.includes(wxid)) wxids.push(wxid)
      }
      const acct = wxKeyService.detectCurrentAccount(dbPath, 10) || wxKeyService.detectCurrentAccount(dbPath, 60)
      pushWxid(acct?.wxid)
      try {
        for (const wxid of dbPathService.scanWxids(dbPath)) pushWxid(wxid)
      } catch {
        // ignore
      }
      if (wxids.length === 0) {
        return { success: false, error: '未在数据库目录下找到微信账号' }
      }

      const contactDbFor = (wxid: string): string | undefined => {
        return [
          join(dbPath, wxid, 'db_storage', 'contact', 'contact.db'),
          join(dbPath, 'db_storage', 'contact', 'contact.db'),
        ].find(existsSync)
      }

      // 轮询内存扫描（自适应：默认不提权直接扫；若检测到一字节都读不到，
      // 判定为权限不足，返回 needAdmin 让前端提示用管理员重开）。命中后数据库验证。
      event.sender.send('wxkey:status', { status: '微信启动中，正在扫描内存获取密钥...', level: 1 })
      const deadline = Date.now() + 120000
      let lastError = ''
      let sawBytes = false
      let rounds = 0
      const needAdminResult = {
        success: false,
        needAdmin: true,
        error: '无法读取微信内存（读到 0 字节），通常是权限不足。请用管理员身份重新打开密语后重试。'
      }
      while (Date.now() < deadline) {
        rounds++
        // 快速路径：一次性从 global_config 结构提取 db_key + 账号字段（wxid/昵称/微信号/手机号），
        // 不依赖 contact.db。命中后把干净 wxid 前缀匹配成真实目录名，再优先做数据库验证。
        const account = wxKeyService.scanAccount()
        if (account?.dbKey) {
          sawBytes = true
          const bindWxid =
            wxids.find(w => w === account.wxid) ||
            wxids.find(w => w.startsWith(account.wxid + '_')) ||
            wxids.find(w => w.startsWith(account.wxid)) ||
            account.wxid
          const accWxids = bindWxid
            ? [bindWxid, ...wxids.filter(w => w !== bindWxid)]
            : wxids
          for (const wxid of accWxids) {
            event.sender.send('wxkey:status', { status: `已提取账号信息，正在验证: ${account.name || wxid}`, level: 1 })
            const testResult = await wcdbService.testConnection(dbPath, account.dbKey, wxid)
            if (testResult.success) {
              ctx.getLogService()?.info('WxKey', '账号信息提取成功', {
                wxid, hasName: !!account.name, hasNumber: !!account.number, hasPhone: !!account.phone
              })
              return { success: true, key: account.dbKey, validatedWxid: wxid, account: { ...account, wxid } }
            }
            lastError = testResult.error || ''
          }
        }
        for (const wxid of wxids) {
          const contactDb = contactDbFor(wxid)
          if (!contactDb) continue
          const diag = wxKeyService.scanDbKeyDiag(contactDb)
          if (!diag) continue
          if (diag.bytes > 0) sawBytes = true
          if (diag.key) {
            event.sender.send('wxkey:status', { status: `已捕获候选密钥，正在验证账号: ${wxid}`, level: 1 })
            const testResult = await wcdbService.testConnection(dbPath, diag.key, wxid)
            if (testResult.success) {
              ctx.getLogService()?.info('WxKey', '内存扫描密钥获取成功', { wxid, keyLength: diag.key.length })
              return { success: true, key: diag.key, validatedWxid: wxid, account: account ?? null }
            }
            lastError = testResult.error || ''
          }
        }
        // 连续多轮一字节都读不到 → 基本可判定权限不足，提前结束提示提权
        if (rounds >= 8 && !sawBytes) {
          ctx.getLogService()?.warn('WxKey', '内存读取为 0 字节，疑似权限不足')
          return needAdminResult
        }
        await new Promise(resolve => setTimeout(resolve, 1500))
      }

      if (!sawBytes) {
        ctx.getLogService()?.warn('WxKey', '内存读取始终为 0 字节，疑似权限不足')
        return needAdminResult
      }
      ctx.getLogService()?.warn('WxKey', '内存扫描超时未获取到密钥', { lastError })
      return {
        success: false,
        error: lastError || '扫描超时未获取到密钥。请确认微信已完成登录，进入任意聊天触发数据库访问后重试。'
      }
    } catch (e) {
      ctx.getLogService()?.error('WxKey', '获取密钥异常', { error: String(e) })
      return { success: false, error: String(e) }
    }
  })

  ipcMain.handle('wxkey:cancel', async () => {
    if (process.platform === 'darwin') {
      wxKeyServiceMac.dispose()
      return true
    }
    wxKeyService.dispose()
    return true
  })

  ipcMain.handle('wxkey:detectCurrentAccount', async (_, dbPath?: string, maxTimeDiffMinutes?: number) => {
    if (process.platform === 'darwin') {
      return wxKeyServiceMac.detectCurrentAccount(dbPath, maxTimeDiffMinutes)
    }
    return wxKeyService.detectCurrentAccount(dbPath, maxTimeDiffMinutes)
  })

  // 数据库路径相关

}
