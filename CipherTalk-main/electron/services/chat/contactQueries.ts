import { dbAdapter } from '../dbAdapter'
import { detectContactInfoType } from './constants'
import { cleanAccountDirName } from './accountUtils'
import { resolveWeComCorpName } from './weComResolver'
import type { ContactInfo, Contact } from './types'
import type { ChatServiceState } from './state'

/**
 * 获取通讯录列表
 */
export async function getContacts(state: ChatServiceState): Promise<{ success: boolean; contacts?: ContactInfo[]; error?: string }> {
  try {
    // 消费预加载缓存
    if (state.preloadCache.builtAt > 0 &&
        Date.now() - state.preloadCache.builtAt < state.PRELOAD_CACHE_TTL &&
        state.preloadCache.contacts) {
      const cached = state.preloadCache.contacts
      state.preloadCache.contacts = null
      return cached
    }

    // 获取会话表的最后联系时间
    const lastContactTimeMap = new Map<string, number>()
    try {
      const tables = await dbAdapter.all<any>(
        'session',
        '',
        "SELECT name FROM sqlite_master WHERE type='table'"
      )
      const tableNames = tables.map((t: any) => t.name)

      let sessionTableName: string | null = null
      for (const name of ['SessionTable', 'Session', 'session']) {
        if (tableNames.includes(name)) {
          sessionTableName = name
          break
        }
      }

      if (sessionTableName) {
        const sessionRows = await dbAdapter.all<any>(
          'session',
          '',
          `SELECT username, user_name, userName, sort_timestamp, sortTimestamp FROM ${sessionTableName}`
        )

        for (const row of sessionRows) {
          const username = row.username || row.user_name || row.userName || ''
          const timestamp = row.sort_timestamp || row.sortTimestamp || 0
          if (username && timestamp) {
            lastContactTimeMap.set(username, timestamp)
          }
        }
      }
    } catch (e) {
      // 忽略错误，继续使用默认排序
    }

    // 获取表结构
    const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
    const columnNames = columns.map((c: any) => c.name)

    const hasBigHeadUrl = columnNames.includes('big_head_url')
    const hasSmallHeadUrl = columnNames.includes('small_head_url')
    const hasLocalType = columnNames.includes('local_type')
    const hasType = columnNames.includes('type')
    const hasExtraBuffer = columnNames.includes('extra_buffer')

    const selectCols = ['username', 'remark', 'nick_name', 'alias', 'quan_pin', 'flag']
    if (hasBigHeadUrl) selectCols.push('big_head_url')
    if (hasSmallHeadUrl) selectCols.push('small_head_url')
    if (hasLocalType) selectCols.push('local_type')
    if (hasType) selectCols.push('type')
    if (hasExtraBuffer) selectCols.push('extra_buffer')

    const rows = await dbAdapter.all<any>(
      'contact',
      '',
      `SELECT ${selectCols.join(', ')} FROM contact`
    )

    const contacts: ContactInfo[] = []

    for (const row of rows) {
      const username = row.username || ''
      if (!username) continue

      const type = detectContactInfoType(username, row)
      if (!type) continue

      const displayName = row.remark || row.nick_name || row.alias || username
      let avatarUrl: string | undefined
      if (hasBigHeadUrl && row.big_head_url) {
        avatarUrl = row.big_head_url
      } else if (hasSmallHeadUrl && row.small_head_url) {
        avatarUrl = row.small_head_url
      }

      const isWeCom = username.includes('@openim') && !username.includes('@kefu.openim')
      const weComCorp = (isWeCom && hasExtraBuffer && row.extra_buffer)
        ? await resolveWeComCorpName(state, row.extra_buffer, [row.remark, row.nick_name, row.alias, username])
        : undefined

      contacts.push({
        username,
        displayName,
        remark: row.remark || undefined,
        nickname: row.nick_name || undefined,
        avatarUrl,
        type,
        isWeCom: isWeCom || undefined,
        weComCorp,
        lastContactTime: lastContactTimeMap.get(username) || 0
      } as ContactInfo & { lastContactTime: number })
    }

    // 按最近联系时间排序（有联系记录的在前，时间越近越靠前）
    contacts.sort((a, b) => {
      const timeA = (a as any).lastContactTime || 0
      const timeB = (b as any).lastContactTime || 0
      if (timeA && timeB) {
        return timeB - timeA
      }
      if (timeA && !timeB) return -1
      if (!timeA && timeB) return 1
      return a.displayName.localeCompare(b.displayName, 'zh-CN')
    })

    return { success: true, contacts }
  } catch (e) {
    console.error('ChatService: 获取通讯录失败:', e)
    return { success: false, error: String(e) }
  }
}

export async function getContact(username: string): Promise<Contact | null> {
  try {
    const row = await dbAdapter.get<any>(
      'contact',
      '',
      'SELECT username, alias, remark, nick_name as nickName FROM contact WHERE username = ?',
      [username]
    )

    if (!row) return null

    return {
      username: row.username,
      alias: row.alias || '',
      remark: row.remark || '',
      nickName: row.nickName || ''
    }
  } catch {
    return null
  }
}

/**
 * 获取联系人头像和显示名称（用于群聊消息）
 */
export async function getContactAvatar(state: ChatServiceState, username: string): Promise<{ avatarUrl?: string; displayName?: string; weComCorp?: string } | null> {
  if (!username) return null

  try {
    // 使用缓存的列信息
    if (!state.contactColumnsCache) {
      const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
      const columnNames = columns.map((c: any) => c.name)

      const hasBigHeadUrl = columnNames.includes('big_head_url')
      const hasSmallHeadUrl = columnNames.includes('small_head_url')
      const hasExtraBuffer = columnNames.includes('extra_buffer')

      const selectCols = ['username', 'remark', 'nick_name', 'alias']
      if (hasBigHeadUrl) selectCols.push('big_head_url')
      if (hasSmallHeadUrl) selectCols.push('small_head_url')
      if (hasExtraBuffer) selectCols.push('extra_buffer')
      if (columnNames.includes('flag')) selectCols.push('flag')

      state.contactColumnsCache = { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols }
    }

    const { hasBigHeadUrl, hasSmallHeadUrl, hasExtraBuffer, selectCols } = state.contactColumnsCache

    const row = await dbAdapter.get<any>(
      'contact',
      '',
      `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
      [username]
    )

    if (!row) {
      const avatarUrl = await getAvatarFromHeadImageDb(state, username)
      return avatarUrl ? { avatarUrl, displayName: username } : null
    }

    const displayName = row.remark || row.nick_name || row.alias || username
    let avatarUrl = (hasBigHeadUrl && row.big_head_url)
      ? row.big_head_url
      : (hasSmallHeadUrl && row.small_head_url)
        ? row.small_head_url
        : undefined

    // 如果没有头像 URL，尝试从 head_image.db 获取
    if (!avatarUrl) {
      avatarUrl = await getAvatarFromHeadImageDb(state, username)
    }

    let weComCorp: string | undefined
    if (username.includes('@openim') && !username.includes('@kefu.openim') && hasExtraBuffer && row.extra_buffer) {
      weComCorp = await resolveWeComCorpName(state, 
        row.extra_buffer,
        [row.remark, row.nick_name, row.alias, username]
      )
    }

    return { avatarUrl, displayName, weComCorp }
  } catch {
    return null
  }
}

/**
 * 解析转账消息中的付款方和收款方显示名称
 * 优先使用群昵称（从 chatroom_info 表），群昵称为空时回退到微信昵称/备注
 */
export async function resolveTransferDisplayNames(
  state: ChatServiceState,
  chatroomId: string,
  payerUsername: string,
  receiverUsername: string
): Promise<{ payerName: string; receiverName: string }> {
  try {
    // 如果是群聊，尝试从 contact.db 获取群昵称
    let groupNicknames: Record<string, string> = {}
    if (chatroomId.endsWith('@chatroom')) {
      try {
        // 尝试从 chatroom_info 表获取群成员昵称
        const tables = await dbAdapter.all<any>(
          'contact',
          '',
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%chatroom%'"
        )
        for (const t of tables) {
          try {
            const rows = await dbAdapter.all<any>(
              'contact',
              '',
              `SELECT * FROM ${t.name} WHERE chatroom_name = ? OR username = ?`,
              [chatroomId, chatroomId]
            )
            for (const row of rows) {
              const roomData = row.room_data || row.ext_buffer || ''
              if (roomData && typeof roomData === 'string') {
                const memberRegex = /<member>[\s\S]*?<username>(.*?)<\/username>[\s\S]*?<displayName>(.*?)<\/displayName>[\s\S]*?<\/member>/gi
                let match
                while ((match = memberRegex.exec(roomData)) !== null) {
                  if (match[1] && match[2]) {
                    groupNicknames[match[1]] = match[2]
                  }
                }
              }
            }
          } catch { /* 表结构不匹配，跳过 */ }
        }
      } catch { /* 查询失败，继续用联系人信息兜底 */ }
    }

    // 获取当前用户 wxid，用于识别"自己"
    const myWxid = state.configService.get('myWxid')
    const cleanedMyWxid = myWxid ? cleanAccountDirName(myWxid) : ''

    // 解析名称：自己 > 群昵称 > 备注 > 昵称 > alias > wxid
    const resolveName = async (username: string): Promise<string> => {
      if (!username) return username

      if (myWxid && (username === myWxid || username === cleanedMyWxid)) {
        const myGroupNick = groupNicknames[username]
        if (myGroupNick) return myGroupNick
        try {
          const myInfo = await getMyUserInfo(state)
          if (myInfo.success && myInfo.userInfo?.nickName) {
            return myInfo.userInfo.nickName
          }
        } catch { /* ignore */ }
        return '我'
      }

      const groupNick = groupNicknames[username]
      if (groupNick) return groupNick

      const contact = await getContact(username)
      if (contact) {
        return contact.remark || contact.nickName || contact.alias || username
      }
      return username
    }

    const [payerName, receiverName] = await Promise.all([
      resolveName(payerUsername),
      resolveName(receiverUsername)
    ])

    return { payerName, receiverName }
  } catch {
    return { payerName: payerUsername, receiverName: receiverUsername }
  }
}

/**
 * 从 head_image.db 获取头像（转换为 base64 data URL）
 */
export async function getAvatarFromHeadImageDb(state: ChatServiceState, username: string): Promise<string | undefined> {
  if (!username) return undefined

  try {
    // 检查缓存
    if (state.avatarBase64Cache.has(username)) {
      return state.avatarBase64Cache.get(username)
    }

    const row = await dbAdapter.get<any>(
      'head_image',
      '',
      'SELECT image_buffer FROM head_image WHERE username = ?',
      [username]
    )

    if (!row || !row.image_buffer) return undefined

    // 将 Buffer 转换为 base64 data URL
    const buffer = Buffer.from(row.image_buffer)
    const base64 = buffer.toString('base64')
    const dataUrl = `data:image/jpeg;base64,${base64}`

    // 缓存结果
    state.avatarBase64Cache.set(username, dataUrl)

    return dataUrl
  } catch (e: any) {
    // 如果是数据库损坏错误，只记录一次警告，避免刷屏
    if (e?.code === 'SQLITE_CORRUPT' || e?.message?.includes('malformed')) {
      if (!state.headImageDbCorrupted) {
        console.warn(`[ChatService] head_image.db 数据库文件损坏，头像功能可能受影响`)
        state.headImageDbCorrupted = true
      }
    } else {
      console.error(`获取 ${username} 的头像失败:`, e)
    }
    return undefined
  }
}

/**
 * 获取当前用户的头像 URL
 */
export async function getMyAvatarUrl(state: ChatServiceState): Promise<{ success: boolean; avatarUrl?: string; error?: string }> {
  try {
    const myWxid = state.configService.get('myWxid')
    if (!myWxid) {
      return { success: false, error: '未配置微信ID' }
    }

    // 检查 contact 表是否存在
    const tables = await dbAdapter.all<any>(
      'contact',
      '',
      "SELECT name FROM sqlite_master WHERE type='table' AND name='contact'"
    )

    if (tables.length === 0) {
      return { success: false, error: 'contact 表不存在' }
    }

    // 获取表结构
    const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
    const columnNames = columns.map((c: any) => c.name)

    const hasBigHeadUrl = columnNames.includes('big_head_url')
    const hasSmallHeadUrl = columnNames.includes('small_head_url')

    if (!hasBigHeadUrl && !hasSmallHeadUrl) {
      return { success: false, error: '联系人表中没有头像字段' }
    }

    const selectCols = ['username']
    if (hasBigHeadUrl) selectCols.push('big_head_url')
    if (hasSmallHeadUrl) selectCols.push('small_head_url')

    // 使用原始 wxid 查询
    const row = await dbAdapter.get<any>(
      'contact',
      '',
      `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
      [myWxid]
    )

    if (!row) {
      // 如果找不到，尝试用清理后的 wxid
      const cleanedWxid = cleanAccountDirName(myWxid)

      const row2 = await dbAdapter.get<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
        [cleanedWxid]
      )

      if (!row2) {
        const fallbackAvatarUrl = await getAvatarFromHeadImageDb(state, cleanedWxid || myWxid) || await getAvatarFromHeadImageDb(state, myWxid)
        return { success: true, avatarUrl: fallbackAvatarUrl }
      }

      const avatarUrl2 = (hasBigHeadUrl && row2.big_head_url)
        ? row2.big_head_url
        : (hasSmallHeadUrl && row2.small_head_url)
          ? row2.small_head_url
          : undefined
      const resolvedAvatarUrl2 = avatarUrl2 || await getAvatarFromHeadImageDb(state, row2.username || cleanedWxid)

      return { success: true, avatarUrl: resolvedAvatarUrl2 }
    }

    const avatarUrl = (hasBigHeadUrl && row.big_head_url)
      ? row.big_head_url
      : (hasSmallHeadUrl && row.small_head_url)
        ? row.small_head_url
        : undefined
    const resolvedAvatarUrl = avatarUrl || await getAvatarFromHeadImageDb(state, row.username || myWxid)

    return { success: true, avatarUrl: resolvedAvatarUrl }
  } catch (e) {
    console.error('ChatService: 获取当前用户头像失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 获取当前用户的完整信息（昵称、微信号、头像）
 */
export async function getMyUserInfo(state: ChatServiceState): Promise<{
  success: boolean
  userInfo?: {
    wxid: string
    nickName: string
    alias: string
    avatarUrl: string
  }
  error?: string
}> {
  try {
    const myWxid = state.configService.get('myWxid')
    if (!myWxid) {
      return { success: false, error: '未配置微信ID' }
    }

    // 检查 contact 表是否存在
    const tables = await dbAdapter.all<any>(
      'contact',
      '',
      "SELECT name FROM sqlite_master WHERE type='table' AND name='contact'"
    )

    if (tables.length === 0) {
      return { success: false, error: 'contact 表不存在' }
    }

    // 获取表结构
    const columns = await dbAdapter.all<any>('contact', '', "PRAGMA table_info(contact)")
    const columnNames = columns.map((c: any) => c.name)

    const hasBigHeadUrl = columnNames.includes('big_head_url')
    const hasSmallHeadUrl = columnNames.includes('small_head_url')

    const selectCols = ['username', 'nick_name', 'alias']
    if (hasBigHeadUrl) selectCols.push('big_head_url')
    if (hasSmallHeadUrl) selectCols.push('small_head_url')

    // 使用原始 wxid 查询
    let row = await dbAdapter.get<any>(
      'contact',
      '',
      `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
      [myWxid]
    )

    if (!row) {
      // 如果找不到，尝试用清理后的 wxid
      const cleanedWxid = cleanAccountDirName(myWxid)
      row = await dbAdapter.get<any>(
        'contact',
        '',
        `SELECT ${selectCols.join(', ')} FROM contact WHERE username = ?`,
        [cleanedWxid]
      )
    }

    if (!row) {
      const cleanedWxid = cleanAccountDirName(myWxid)
      const fallbackAvatarUrl = await getAvatarFromHeadImageDb(state, cleanedWxid || myWxid) || await getAvatarFromHeadImageDb(state, myWxid)
      return {
        success: true,
        userInfo: {
          wxid: myWxid,
          nickName: '',
          alias: '',
          avatarUrl: fallbackAvatarUrl || ''
        }
      }
    }

    const avatarUrl = (hasBigHeadUrl && row.big_head_url)
      ? row.big_head_url
      : (hasSmallHeadUrl && row.small_head_url)
        ? row.small_head_url
        : ''
    const resolvedAvatarUrl = avatarUrl || await getAvatarFromHeadImageDb(state, row.username || myWxid) || ''

    return {
      success: true,
      userInfo: {
        wxid: myWxid,
        nickName: row.nick_name || '',
        alias: row.alias || '',
        avatarUrl: resolvedAvatarUrl
      }
    }
  } catch (e) {
    console.error('ChatService: 获取当前用户信息失败:', e)
    return { success: false, error: String(e) }
  }
}

/**
 * 从 misc.db 获取 UIN（微信账号ID）
 * UIN 用于表情包缓存解密的密钥派生
 */
export async function getUinFromMiscDb(): Promise<string | null> {
  try {
    // 尝试从 DBInfo 表获取 UIN
    try {
      const row = await dbAdapter.get<any>(
        'misc',
        '',
        "SELECT value FROM DBInfo WHERE key = 'uin'"
      )

      if (row && row.value) {
        return String(row.value)
      }
    } catch {
      // DBInfo 表可能不存在或结构不同
    }

    // 备选：尝试从其他可能的表获取 UIN
    try {
      const tables = await dbAdapter.all<any>(
        'misc',
        '',
        "SELECT name FROM sqlite_master WHERE type='table'"
      )
      for (const table of tables) {
        const tableName = table.name
        if (tableName.toLowerCase().includes('info') || tableName.toLowerCase().includes('account')) {
          try {
            const columns = await dbAdapter.all<any>('misc', '', `PRAGMA table_info(${tableName})`)
            const columnNames = columns.map((c: any) => c.name)

            if (columnNames.includes('uin')) {
              const uinRow = await dbAdapter.get<any>('misc', '', `SELECT uin FROM ${tableName} LIMIT 1`)
              if (uinRow && uinRow.uin) {
                return String(uinRow.uin)
              }
            }
          } catch {
            // 跳过无法查询的表
          }
        }
      }
    } catch {
      // 无法扫描表
    }

    return null
  } catch (e) {
    console.error('ChatService: 从 misc.db 获取 UIN 失败:', e)
    return null
  }
}
