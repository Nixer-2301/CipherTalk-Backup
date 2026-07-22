import { contextBridge, ipcRenderer } from 'electron'
import type { AccountProfile } from '../src/types/account'
import type { AgentReasoningEffort } from './services/agent/types'

function getMcpLaunchConfigSafe(): Promise<{
  command: string
  args: string[]
  cwd: string
  mode: 'dev' | 'packaged'
} | null> {
  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const responseChannel = `app:getMcpLaunchConfig:response:${requestId}`
    const timeout = setTimeout(() => {
      ipcRenderer.removeAllListeners(responseChannel)
      resolve(null)
    }, 600)

    ipcRenderer.once(responseChannel, (_, payload) => {
      clearTimeout(timeout)
      resolve(payload ?? null)
    })

    ipcRenderer.send('app:getMcpLaunchConfig:request', { requestId })
  })
}

// 暴露给渲染进程的 API
contextBridge.exposeInMainWorld('electronAPI', {
  // 配置
  config: {
    get: (key: string) => ipcRenderer.invoke('config:get', key),
    set: (key: string, value: any) => ipcRenderer.invoke('config:set', key, value),
    getTldCache: () => ipcRenderer.invoke('config:getTldCache'),
    setTldCache: (tlds: string[]) => ipcRenderer.invoke('config:setTldCache', tlds),
    onChanged: (callback: (payload: { key: string; value: unknown }) => void) => {
      const listener = (_: any, payload: { key: string; value: unknown }) => callback(payload)
      ipcRenderer.on('config:changed', listener)
      return () => { ipcRenderer.removeListener('config:changed', listener) }
    }
  },

  // 插件系统（见 PLUGIN_SYSTEM_PLAN.md）
  plugin: {
    list: () => ipcRenderer.invoke('plugin:list') as Promise<{ plugins: any[]; devModeEnabled: boolean }>,
    enable: (id: string) => ipcRenderer.invoke('plugin:enable', id) as Promise<{ success: boolean; error?: string }>,
    disable: (id: string) => ipcRenderer.invoke('plugin:disable', id) as Promise<{ success: boolean; error?: string }>,
    uninstall: (id: string) => ipcRenderer.invoke('plugin:uninstall', id) as Promise<{ success: boolean; error?: string }>,
    rescan: () => ipcRenderer.invoke('plugin:rescan') as Promise<{ success: boolean }>,
    setDevMode: (enabled: boolean) => ipcRenderer.invoke('plugin:setDevMode', enabled) as Promise<{ success: boolean }>,
    addDevPlugin: (dir: string) => ipcRenderer.invoke('plugin:addDevPlugin', dir) as Promise<{ success: boolean; error?: string }>,
    installFromFile: () => ipcRenderer.invoke('plugin:installFromFile') as Promise<{ success: boolean; canceled?: boolean; pluginId?: string; name?: string; error?: string }>,
    getViewUrl: (pluginId: string, viewId: string) => ipcRenderer.invoke('plugin:getViewUrl', pluginId, viewId) as Promise<string | null>,
    invoke: (pluginId: string, method: string, args?: Record<string, unknown>) =>
      ipcRenderer.invoke('plugin:invoke', pluginId, method, args) as Promise<{ success: boolean; data?: unknown; error?: string }>,
    onChanged: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('plugin:changed', listener)
      return () => { ipcRenderer.removeListener('plugin:changed', listener) }
    },
    onEvent: (callback: (payload: { pluginId: string | null; requiredPermission?: string; event: string; payload: unknown }) => void) => {
      const listener = (_: any, data: any) => callback(data)
      ipcRenderer.on('plugin:event', listener)
      return () => { ipcRenderer.removeListener('plugin:event', listener) }
    }
  },

  // AI 宠物（petdex 格式）
  pet: {
    listInstalled: () => ipcRenderer.invoke('pet:listInstalled') as Promise<{ success: boolean; pets?: Array<{ slug: string; displayName: string; description: string; builtin?: boolean }>; error?: string }>,
    manifest: (force?: boolean) => ipcRenderer.invoke('pet:manifest', force) as Promise<{ success: boolean; pets?: Array<{ slug: string; displayName: string; kind?: string; submittedBy?: string; spritesheetUrl: string; petJsonUrl: string }>; error?: string }>,
    install: (slug: string) => ipcRenderer.invoke('pet:install', slug) as Promise<{ success: boolean; pet?: { slug: string; displayName: string; description: string; builtin?: boolean }; error?: string }>,
    remove: (slug: string) => ipcRenderer.invoke('pet:remove', slug) as Promise<{ success: boolean; error?: string }>,
    importZip: () => ipcRenderer.invoke('pet:importZip') as Promise<{ success: boolean; canceled?: boolean; pet?: { slug: string; displayName: string; description: string; builtin?: boolean }; error?: string }>,
    getSprite: (slug: string) => ipcRenderer.invoke('pet:getSprite', slug) as Promise<{ success: boolean; dataUrl?: string; error?: string }>,
    setAgentState: (state: string) => ipcRenderer.send('pet:agentState', state),
    sendAgentProgress: (progress: { stage: string; title: string; detail?: string }) => ipcRenderer.send('pet:agentProgress', progress),
    getDailySummary: () => ipcRenderer.invoke('pet:getDailySummary') as Promise<{ success: boolean; text?: string; error?: string }>,
    toggleDesktopWindow: (enabled: boolean) => ipcRenderer.invoke('pet:toggleDesktopWindow', enabled) as Promise<{ success: boolean }>,
    setBubble: (expanded: boolean) => ipcRenderer.send('pet:setBubble', expanded),
    showContextMenu: () => ipcRenderer.send('pet:showContextMenu'),
    dragStart: () => ipcRenderer.send('pet:dragStart'),
    dragMove: (dx: number, dy: number) => ipcRenderer.send('pet:dragMove', dx, dy),
    dragEnd: () => ipcRenderer.send('pet:dragEnd'),
    onAgentState: (callback: (state: string) => void) => {
      const listener = (_: any, state: string) => callback(state)
      ipcRenderer.on('pet:agentState', listener)
      return () => { ipcRenderer.removeListener('pet:agentState', listener) }
    },
    onWindowMove: (callback: (x: number) => void) => {
      const listener = (_: any, x: number) => callback(x)
      ipcRenderer.on('pet:windowMove', listener)
      return () => { ipcRenderer.removeListener('pet:windowMove', listener) }
    },
    onBubbleFrame: (callback: (frame: { expanded: boolean; baseLeft: number; baseTop: number; baseWidth: number; baseHeight: number }) => void) => {
      const listener = (_: any, frame: any) => callback(frame)
      ipcRenderer.on('pet:bubbleFrame', listener)
      return () => { ipcRenderer.removeListener('pet:bubbleFrame', listener) }
    },
    onContextMenuOpened: (callback: () => void) => {
      const listener = () => callback()
      ipcRenderer.on('pet:contextMenuOpened', listener)
      return () => { ipcRenderer.removeListener('pet:contextMenuOpened', listener) }
    },
    onNotify: (callback: (payload: { username: string; displayName: string; avatarUrl?: string; preview: string; timestamp: number }) => void) => {
      const listener = (_: any, payload: any) => callback(payload)
      ipcRenderer.on('pet:notify', listener)
      return () => { ipcRenderer.removeListener('pet:notify', listener) }
    },
    onAgentProgress: (callback: (progress: { stage: string; title: string; detail?: string }) => void) => {
      const listener = (_: any, progress: any) => callback(progress)
      ipcRenderer.on('pet:agentProgress', listener)
      return () => { ipcRenderer.removeListener('pet:agentProgress', listener) }
    },
    onBubble: (callback: (payload: { kind: string; title: string; text: string; id?: string }) => void) => {
      const listener = (_: any, payload: any) => callback(payload)
      ipcRenderer.on('pet:bubble', listener)
      return () => { ipcRenderer.removeListener('pet:bubble', listener) }
    }
  },

  // 消息提醒（会话级开关，默认全关）
  notify: {
    getEnabledSessions: () => ipcRenderer.invoke('notify:getEnabledSessions') as Promise<string[]>,
    setSessionEnabled: (username: string, enabled: boolean) => ipcRenderer.invoke('notify:setSessionEnabled', username, enabled) as Promise<{ success: boolean }>,
    setActiveSession: (sessionId: string | null) => ipcRenderer.send('notify:setActiveSession', sessionId),
    activate: () => ipcRenderer.send('notify:activate'),
  },

  // 设备连接（微信 iLink 直连）
  deviceConnect: {
    wechat: {
      getStatus: () => ipcRenderer.invoke('deviceConnect:wechat:getStatus') as Promise<{ status: 'disconnected' | 'connecting' | 'connected' | 'error'; botId: string | null; userId: string | null; error: string | null }>,
      connect: () => ipcRenderer.invoke('deviceConnect:wechat:connect') as Promise<{ success: boolean; qrcodeImage?: string; error?: string }>,
      cancel: () => ipcRenderer.invoke('deviceConnect:wechat:cancel') as Promise<{ success: boolean }>,
      disconnect: () => ipcRenderer.invoke('deviceConnect:wechat:disconnect') as Promise<{ success: boolean }>,
      onStatus: (callback: (payload: { status: 'disconnected' | 'connecting' | 'connected' | 'error'; botId: string | null; userId: string | null; error: string | null }) => void) => {
        const listener = (_: any, payload: any) => callback(payload)
        ipcRenderer.on('deviceConnect:wechat:status', listener)
        return () => { ipcRenderer.removeListener('deviceConnect:wechat:status', listener) }
      },
      onQrcode: (callback: (payload: { qrcodeImage: string }) => void) => {
        const listener = (_: any, payload: any) => callback(payload)
        ipcRenderer.on('deviceConnect:wechat:qrcode', listener)
        return () => { ipcRenderer.removeListener('deviceConnect:wechat:qrcode', listener) }
      },
      onScanState: (callback: (payload: { state: 'scaned' | 'failed'; error?: string }) => void) => {
        const listener = (_: any, payload: any) => callback(payload)
        ipcRenderer.on('deviceConnect:wechat:scanState', listener)
        return () => { ipcRenderer.removeListener('deviceConnect:wechat:scanState', listener) }
      },
    },
  },

  accounts: {
    list: () => ipcRenderer.invoke('accounts:list') as Promise<AccountProfile[]>,
    getActive: () => ipcRenderer.invoke('accounts:getActive') as Promise<AccountProfile | null>,
    setActive: (accountId: string) => ipcRenderer.invoke('accounts:setActive', accountId) as Promise<AccountProfile | null>,
    save: (profile: Omit<AccountProfile, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>) => ipcRenderer.invoke('accounts:save', profile) as Promise<AccountProfile | null>,
    update: (accountId: string, patch: Partial<Omit<AccountProfile, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt'>>) =>
      ipcRenderer.invoke('accounts:update', accountId, patch) as Promise<AccountProfile | null>,
    delete: (accountId: string, deleteLocalData?: boolean) =>
      ipcRenderer.invoke('accounts:delete', accountId, deleteLocalData) as Promise<{ success: boolean; error?: string; deleted?: AccountProfile | null; nextActiveAccountId?: string }>
  },

  skillManager: {
    list: () => ipcRenderer.invoke('skillManager:list') as Promise<Array<{ name: string; version: string; description: string; builtin: boolean }>>,
    readContent: (skillName: string) => ipcRenderer.invoke('skillManager:readContent', skillName) as Promise<{ success: boolean; content?: string; error?: string }>,
    listFiles: (skillName: string) => ipcRenderer.invoke('skillManager:listFiles', skillName) as Promise<{ success: boolean; files?: Array<{ path: string; name: string; type: 'file' | 'dir'; size?: number; children?: Array<{ path: string; name: string; type: 'file' | 'dir'; size?: number }> }>; truncated?: boolean; error?: string }>,
    readFile: (skillName: string, filePath: string) => ipcRenderer.invoke('skillManager:readFile', skillName, filePath) as Promise<{ success: boolean; path?: string; content?: string; size?: number; binary?: boolean; error?: string }>,
    updateContent: (skillName: string, content: string) => ipcRenderer.invoke('skillManager:updateContent', skillName, content) as Promise<{ success: boolean; error?: string }>,
    exportZip: (skillName: string) => ipcRenderer.invoke('skillManager:exportZip', skillName) as Promise<{ success: boolean; outputPath?: string; fileName?: string; version?: string; error?: string }>,
    importZip: (zipPath: string) => ipcRenderer.invoke('skillManager:importZip', zipPath) as Promise<{ success: boolean; skillName?: string; error?: string }>,
    delete: (skillName: string) => ipcRenderer.invoke('skillManager:delete', skillName) as Promise<{ success: boolean; error?: string }>,
    create: (skillName: string, content: string) => ipcRenderer.invoke('skillManager:create', skillName, content) as Promise<{ success: boolean; error?: string }>,
  },

  mcpClient: {
    listConfigs: () => ipcRenderer.invoke('mcpClient:listConfigs') as Promise<Record<string, { type: string; command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; headers?: Record<string, string>; timeoutMs?: number; autoConnect?: boolean }>>,
    saveConfig: (name: string, config: any, overwrite?: boolean) => ipcRenderer.invoke('mcpClient:saveConfig', name, config, overwrite) as Promise<{ success: boolean; error?: string }>,
    deleteConfig: (name: string) => ipcRenderer.invoke('mcpClient:deleteConfig', name) as Promise<{ success: boolean; error?: string }>,
    connect: (name: string) => ipcRenderer.invoke('mcpClient:connect', name) as Promise<{ success: boolean; tools?: Array<{ name: string; description?: string }>; error?: string }>,
    disconnect: (name: string) => ipcRenderer.invoke('mcpClient:disconnect', name) as Promise<{ success: boolean; error?: string }>,
    listTools: (name: string) => ipcRenderer.invoke('mcpClient:listTools', name) as Promise<{ success: boolean; tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>; error?: string }>,
    callTool: (name: string, toolName: string, args: any) => ipcRenderer.invoke('mcpClient:callTool', name, toolName, args) as Promise<{ success: boolean; result?: any; error?: string }>,
    listStatuses: () => ipcRenderer.invoke('mcpClient:listStatuses') as Promise<Array<{ name: string; config: any; status: string; toolCount: number; error?: string }>>,
  },

  // AI Agent（主进程 broker → AI 子进程；流式 chunk 经 agent:chunk 推回）
  agent: {
    run: (runId: string, messages: unknown[], scope?: unknown, modelConfig?: unknown, conversationId?: number | null, planMode?: boolean, toolProfile?: unknown, codeWorkspace?: unknown, canvasContext?: unknown) =>
      ipcRenderer.invoke('agent:run', { runId, messages, scope, modelConfig, conversationId, planMode, toolProfile, codeWorkspace, canvasContext }) as Promise<{ success: boolean; error?: string }>,
    abort: (runId: string) => ipcRenderer.invoke('agent:abort', runId) as Promise<{ success: boolean }>,
    generateTitle: (firstMessage: string, modelConfig?: unknown) =>
      ipcRenderer.invoke('agent:generateTitle', { firstMessage, modelConfig }) as Promise<{ success: boolean; title?: string; error?: string }>,
    optimizePrompt: (prompt: string, modelConfig?: unknown, context?: Array<{ role: 'user' | 'assistant'; text: string }>) =>
      ipcRenderer.invoke('agent:optimizePrompt', { prompt, modelConfig, context }) as Promise<{ success: boolean; text?: string; error?: string }>,
    replySuggest: (input: unknown, modelConfig?: unknown) =>
      ipcRenderer.invoke('agent:replySuggest', { input, modelConfig }) as Promise<{ success: boolean; suggestions?: string[]; error?: string }>,
    listConversations: (scope?: unknown) =>
      ipcRenderer.invoke('agent:listConversations', scope) as Promise<{ success: boolean; conversations?: unknown[]; error?: string }>,
    loadConversation: (id: number) =>
      ipcRenderer.invoke('agent:loadConversation', id) as Promise<{ success: boolean; conversation?: unknown; error?: string }>,
    createConversation: (payload: unknown) =>
      ipcRenderer.invoke('agent:createConversation', payload) as Promise<{ success: boolean; conversation?: unknown; error?: string }>,
    deleteConversation: (idOrPayload: number | { id?: number; originClientId?: string | null }) =>
      ipcRenderer.invoke('agent:deleteConversation', idOrPayload) as Promise<{ success: boolean; error?: string }>,
    deleteConversationsByScope: (scope: unknown) =>
      ipcRenderer.invoke('agent:deleteConversationsByScope', scope) as Promise<{ success: boolean; deleted?: number; error?: string }>,
    renameConversation: (id: number, title: string, originClientId?: string | null) =>
      ipcRenderer.invoke('agent:renameConversation', id, title, originClientId) as Promise<{ success: boolean; conversation?: unknown; error?: string }>,
    saveConversationMessages: (payload: unknown) =>
      ipcRenderer.invoke('agent:saveConversationMessages', payload) as Promise<{ success: boolean; conversation?: unknown; staleMerged?: boolean; error?: string }>,
    getLastConversation: (scope?: unknown) =>
      ipcRenderer.invoke('agent:getLastConversation', scope) as Promise<{ success: boolean; conversation?: unknown; error?: string }>,
    sendConversationReplyToWechat: (payload: { conversationId: number; messageId: string; bubbles: string[] }) =>
      ipcRenderer.invoke('agent:sendConversationReplyToWechat', payload) as Promise<{ success: boolean; sent?: boolean; skipped?: boolean; error?: string }>,
    onConversationUpdated: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_e: unknown, event: unknown) => callback(event)
      ipcRenderer.on('agent:conversationUpdated', listener)
      return () => ipcRenderer.removeListener('agent:conversationUpdated', listener)
    },
    onChunk: (runId: string, callback: (chunk: unknown) => void): (() => void) => {
      const listener = (_e: unknown, data: { runId: string; chunk: unknown }) => {
        if (data?.runId === runId) callback(data.chunk)
      }
      ipcRenderer.on('agent:chunk', listener)
      return () => ipcRenderer.removeListener('agent:chunk', listener)
    },
    onProgress: (runId: string, callback: (progress: unknown) => void): (() => void) => {
      const listener = (_e: unknown, data: { runId: string; progress: unknown }) => {
        if (data?.runId === runId) callback(data.progress)
      }
      ipcRenderer.on('agent:progress', listener)
      return () => ipcRenderer.removeListener('agent:progress', listener)
    },
  },

  // Agent Canvas（对话内可编辑产物；主进程单写者，见 agentCanvasHandlers.ts）
  agentCanvas: {
    create: (input: unknown) => ipcRenderer.invoke('agentCanvas:create', input) as Promise<{ success: boolean; canvas?: unknown; error?: string }>,
    get: (canvasId: string) => ipcRenderer.invoke('agentCanvas:get', { canvasId }) as Promise<{ success: boolean; canvas?: unknown; error?: string }>,
    list: (conversationId: number) => ipcRenderer.invoke('agentCanvas:list', { conversationId }) as Promise<{ success: boolean; canvases?: unknown[]; error?: string }>,
    update: (input: unknown) => ipcRenderer.invoke('agentCanvas:update', input) as Promise<{ success: boolean; canvas?: unknown; conflict?: unknown; error?: string }>,
    rename: (input: unknown) => ipcRenderer.invoke('agentCanvas:rename', input) as Promise<{ success: boolean; canvas?: unknown; conflict?: unknown; error?: string }>,
    archive: (input: unknown) => ipcRenderer.invoke('agentCanvas:archive', input) as Promise<{ success: boolean; canvas?: unknown; conflict?: unknown; error?: string }>,
    listRevisions: (canvasId: string) => ipcRenderer.invoke('agentCanvas:listRevisions', { canvasId }) as Promise<{ success: boolean; revisions?: unknown[]; error?: string }>,
    getRevision: (canvasId: string, revision: number) => ipcRenderer.invoke('agentCanvas:getRevision', { canvasId, revision }) as Promise<{ success: boolean; revision?: unknown; error?: string }>,
    restore: (input: unknown) => ipcRenderer.invoke('agentCanvas:restore', input) as Promise<{ success: boolean; canvas?: unknown; conflict?: unknown; error?: string }>,
    onUpdated: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_e: unknown, event: unknown) => callback(event)
      ipcRenderer.on('agentCanvas:updated', listener)
      return () => ipcRenderer.removeListener('agentCanvas:updated', listener)
    },
  },

  agentWorkspace: {
    selectWorkspace: () => ipcRenderer.invoke('agentWorkspace:selectWorkspace') as Promise<{ success: boolean; canceled?: boolean; state?: unknown; error?: string }>,
    clearWorkspace: () => ipcRenderer.invoke('agentWorkspace:clearWorkspace') as Promise<{ success: boolean; state?: unknown; error?: string }>,
    stopDevServer: () => ipcRenderer.invoke('agentWorkspace:stopDevServer') as Promise<{ success: boolean; state?: unknown; result?: unknown; error?: string }>,
    getState: () => ipcRenderer.invoke('agentWorkspace:getState') as Promise<{ success: boolean; state?: unknown; error?: string }>,
    setApprovalPolicy: (policy: unknown) => ipcRenderer.invoke('agentWorkspace:setApprovalPolicy', policy) as Promise<{ success: boolean; state?: unknown; error?: string }>,
    listFiles: (payload: unknown) => ipcRenderer.invoke('agentWorkspace:listFiles', payload) as Promise<{ success: boolean; root?: string; items?: unknown[]; truncated?: boolean; error?: string }>,
    approve: (requestId: string) => ipcRenderer.invoke('agentWorkspace:approve', requestId) as Promise<{ success: boolean }>,
    reject: (requestId: string, _reason?: string) => ipcRenderer.invoke('agentWorkspace:reject', requestId) as Promise<{ success: boolean }>,
    onApprovalRequest: (callback: (request: unknown) => void): (() => void) => {
      const listener = (_e: unknown, request: unknown) => callback(request)
      ipcRenderer.on('agentWorkspace:approvalRequest', listener)
      return () => ipcRenderer.removeListener('agentWorkspace:approvalRequest', listener)
    },
    onWorkspaceEvent: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_e: unknown, event: unknown) => callback(event)
      ipcRenderer.on('agentWorkspace:event', listener)
      return () => ipcRenderer.removeListener('agentWorkspace:event', listener)
    },
  },

  localCodingAgent: {
    getConfig: () => ipcRenderer.invoke('localCodingAgent:getConfig') as Promise<{ success: boolean; config?: unknown; error?: string }>,
    setConfig: (config: unknown) => ipcRenderer.invoke('localCodingAgent:setConfig', config) as Promise<{ success: boolean; config?: unknown; error?: string }>,
    detect: () => ipcRenderer.invoke('localCodingAgent:detect') as Promise<{ success: boolean; results?: unknown[]; error?: string }>,
    run: (payload: unknown) => ipcRenderer.invoke('localCodingAgent:run', payload) as Promise<{ success: boolean; jobId?: string; error?: string }>,
    cancel: (jobId: string) => ipcRenderer.invoke('localCodingAgent:cancel', jobId) as Promise<{ success: boolean; error?: string }>,
    applyPatch: (jobId: string) => ipcRenderer.invoke('localCodingAgent:applyPatch', jobId) as Promise<{ success: boolean; changedPaths?: string[]; error?: string }>,
    discardPatch: (jobId: string) => ipcRenderer.invoke('localCodingAgent:discardPatch', jobId) as Promise<{ success: boolean; changedPaths?: string[]; error?: string }>,
    onEvent: (callback: (event: unknown) => void): (() => void) => {
      const listener = (_e: unknown, event: unknown) => callback(event)
      ipcRenderer.on('localCodingAgent:event', listener)
      return () => ipcRenderer.removeListener('localCodingAgent:event', listener)
    },
  },

  // 克隆好友（数字分身画像；构建进度经 persona:buildProgress 推回）
  persona: {
    get: (sessionId: string) =>
      ipcRenderer.invoke('persona:get', sessionId) as Promise<{ success: boolean; persona?: unknown | null; error?: string }>,
    list: () =>
      ipcRenderer.invoke('persona:list') as Promise<{ success: boolean; personas?: unknown[]; error?: string }>,
    build: (payload: { sessionId: string; displayName?: string }) =>
      ipcRenderer.invoke('persona:build', payload) as Promise<{ success: boolean; persona?: unknown; error?: string }>,
    // 克隆我自己（自画像）：用与克隆好友一致的 AI 管线，按 self: 前缀存储；供"像我"建议使用
    buildSelf: (payload: { sessionId: string; displayName?: string }) =>
      ipcRenderer.invoke('persona:buildSelf', payload) as Promise<{ success: boolean; persona?: unknown; error?: string }>,
    updateSpeakingStyle: (payload: { sessionId: string; card: unknown }) =>
      ipcRenderer.invoke('persona:updateSpeakingStyle', payload) as Promise<{ success: boolean; persona?: unknown; error?: string }>,
    cloneVoice: (payload: { sessionId: string; displayName?: string }) =>
      ipcRenderer.invoke('persona:cloneVoice', payload) as Promise<{ success: boolean; persona?: unknown; voice?: unknown; warning?: string; error?: string }>,
    exportVoiceSample: (payload: { sessionId: string; displayName?: string; outputPath: string }) =>
      ipcRenderer.invoke('persona:exportVoiceSample', payload) as Promise<{ success: boolean; outputPath?: string; sampleCount?: number; sampleSeconds?: number; audioBytes?: number; error?: string }>,
    delete: (sessionId: string) =>
      ipcRenderer.invoke('persona:delete', sessionId) as Promise<{ success: boolean; error?: string }>,
    refreshIfStale: (sessionId: string) =>
      ipcRenderer.invoke('persona:refreshIfStale', { sessionId }) as Promise<{ success: boolean; refreshed?: boolean; persona?: unknown | null; error?: string }>,
    reflect: (payload: { sessionId: string; conversationId: number }) =>
      ipcRenderer.invoke('persona:reflect', payload) as Promise<{ success: boolean; reflected?: boolean; error?: string }>,
    onBuildProgress: (callback: (progress: unknown) => void): (() => void) => {
      const listener = (_e: unknown, progress: unknown) => callback(progress)
      ipcRenderer.on('persona:buildProgress', listener)
      return () => ipcRenderer.removeListener('persona:buildProgress', listener)
    },
    chat: (runId: string, sessionId: string, messages: unknown[], reasoningEffort?: AgentReasoningEffort) =>
      ipcRenderer.invoke('persona:chat', { runId, sessionId, messages, reasoningEffort }) as Promise<{ success: boolean; error?: string }>,
    abort: (runId: string) => ipcRenderer.invoke('persona:abort', runId) as Promise<{ success: boolean }>,
    onChunk: (runId: string, callback: (chunk: unknown) => void): (() => void) => {
      const listener = (_e: unknown, data: { runId: string; chunk: unknown }) => {
        if (data?.runId === runId) callback(data.chunk)
      }
      ipcRenderer.on('persona:chunk', listener)
      return () => ipcRenderer.removeListener('persona:chunk', listener)
    },
    onProgress: (runId: string, callback: (progress: unknown) => void): (() => void) => {
      const listener = (_e: unknown, data: { runId: string; progress: unknown }) => {
        if (data?.runId === runId) callback(data.progress)
      }
      ipcRenderer.on('persona:progress', listener)
      return () => ipcRenderer.removeListener('persona:progress', listener)
    },
  },

  // AI 长期记忆管理（cachePath/memory-bank）
  memory: {
    migrationStatus: () =>
      ipcRenderer.invoke('memory:migrationStatus') as Promise<{ success: boolean; status?: unknown; error?: string }>,
    migrateLegacy: () =>
      ipcRenderer.invoke('memory:migrateLegacy') as Promise<{ success: boolean; result?: unknown; error?: string }>,
    list: (opts?: {
      sourceType?: string
      sourceTypes?: string[]
      sessionId?: string
      tags?: string[]
      withoutTags?: string[]
      minConfidence?: number
      limit?: number
    }) =>
      ipcRenderer.invoke('memory:list', opts) as Promise<{ success: boolean; items?: unknown[]; stats?: { itemCount: number }; error?: string }>,
    listDiaries: (limit?: number) =>
      ipcRenderer.invoke('memory:listDiaries', limit) as Promise<{ success: boolean; diaries?: unknown[]; error?: string }>,
    listBankNotes: (kind: 'tasks' | 'notes', limit?: number) =>
      ipcRenderer.invoke('memory:listBankNotes', kind, limit) as Promise<{ success: boolean; notes?: unknown[]; error?: string }>,
    readBankNote: (kind: 'tasks' | 'notes', fileName: string) =>
      ipcRenderer.invoke('memory:readBankNote', kind, fileName) as Promise<{ success: boolean; note?: unknown; error?: string }>,
    deleteBankNote: (kind: 'tasks' | 'notes', fileName: string) =>
      ipcRenderer.invoke('memory:deleteBankNote', kind, fileName) as Promise<{ success: boolean; error?: string }>,
    readDiary: (date: string) =>
      ipcRenderer.invoke('memory:readDiary', date) as Promise<{ success: boolean; diary?: unknown; error?: string }>,
    deleteDiary: (date: string) =>
      ipcRenderer.invoke('memory:deleteDiary', date) as Promise<{ success: boolean; error?: string }>,
    summarizeTodayDiary: () =>
      ipcRenderer.invoke('memory:summarizeTodayDiary') as Promise<{ success: boolean; alreadyExists?: boolean; diary?: unknown; error?: string }>,
    create: (payload: {
      memoryUid?: string
      sourceType?: string
      content?: string
      title?: string
      importance?: number
      confidence?: number
      tags?: string[]
    }) =>
      ipcRenderer.invoke('memory:create', payload) as Promise<{ success: boolean; item?: unknown; error?: string }>,
    delete: (id: number) =>
      ipcRenderer.invoke('memory:delete', id) as Promise<{ success: boolean; error?: string }>,
    update: (payload: { id: number; sourceType?: string; content?: string; importance?: number; confidence?: number; tags?: string[] }) =>
      ipcRenderer.invoke('memory:update', payload) as Promise<{ success: boolean; item?: unknown; error?: string }>,
    consolidate: () =>
      ipcRenderer.invoke('memory:consolidate') as Promise<{ success: boolean; result?: { removed: number; groups: number; scanned: number }; error?: string }>,
    exportMarkdown: (outputDir: string) =>
      ipcRenderer.invoke('memory:exportMarkdown', outputDir) as Promise<{ success: boolean; result?: { files: string[]; itemCount: number }; error?: string }>,
  },

  // 嵌入模型（语义/向量检索）
  embedding: {
    getConfig: () => ipcRenderer.invoke('embedding:getConfig') as Promise<{ success: boolean; config?: unknown; error?: string }>,
    setConfig: (patch: unknown) => ipcRenderer.invoke('embedding:setConfig', patch) as Promise<{ success: boolean; config?: unknown; error?: string }>,
    test: (cfg: unknown) => ipcRenderer.invoke('embedding:test', cfg) as Promise<{ success: boolean; dimension?: number; error?: string }>,
    sessionStatus: (sessionId: string) => ipcRenderer.invoke('embedding:sessionStatus', sessionId) as Promise<{ success: boolean; enabled?: boolean; mediaEnabled?: boolean; count?: number; mediaCount?: number; store?: unknown; error?: string }>,
    buildSession: (sessionId: string, options?: { target?: 'all' | 'text' | 'image' }) => ipcRenderer.invoke('embedding:buildSession', sessionId, options) as Promise<{ success: boolean; indexed?: number; mediaIndexed?: number; error?: string }>,
    onBuildProgress: (callback: (progress: unknown) => void): (() => void) => {
      const listener = (_e: unknown, progress: unknown) => callback(progress)
      ipcRenderer.on('embedding:buildProgress', listener)
      return () => ipcRenderer.removeListener('embedding:buildProgress', listener)
    },
  },

  // 重排模型（RAG/Skills/MCP 候选重排）
  rerank: {
    getConfig: () => ipcRenderer.invoke('rerank:getConfig') as Promise<{ success: boolean; config?: unknown; error?: string }>,
    setConfig: (patch: unknown) => ipcRenderer.invoke('rerank:setConfig', patch) as Promise<{ success: boolean; config?: unknown; error?: string }>,
    test: (cfg: unknown) => ipcRenderer.invoke('rerank:test', cfg) as Promise<{ success: boolean; error?: string }>,
  },

  // 文字转语音 —— 朗读 AI 回复/微信消息/角色语音回复
  tts: {
    getConfig: () => ipcRenderer.invoke('tts:getConfig') as Promise<{ success: boolean; config?: unknown; available?: boolean; error?: string }>,
    setConfig: (patch: unknown) => ipcRenderer.invoke('tts:setConfig', patch) as Promise<{ success: boolean; config?: unknown; error?: string }>,
    test: (cfg: unknown) => ipcRenderer.invoke('tts:test', cfg) as Promise<{ success: boolean; audioBase64?: string; mimeType?: string; cached?: boolean; error?: string; errorCode?: string }>,
    speak: (text: string, options?: unknown) => ipcRenderer.invoke('tts:speak', text, options) as Promise<{ success: boolean; audioBase64?: string; mimeType?: string; cached?: boolean; error?: string; errorCode?: string }>,
    stream: (streamId: string, text: string, options: unknown, callback: (event: unknown) => void) => {
      const listener = (_e: unknown, event: any) => {
        if (event?.streamId === streamId) callback(event)
      }
      ipcRenderer.on('tts:streamEvent', listener)
      return (ipcRenderer.invoke('tts:stream', streamId, text, options) as Promise<unknown>)
        .finally(() => ipcRenderer.removeListener('tts:streamEvent', listener))
    },
    cancelStream: (streamId: string) => ipcRenderer.invoke('tts:streamCancel', streamId) as Promise<{ success: boolean }>,
  },

  // 豆包端到端实时语音。凭据和分身画像只在主进程读取，渲染端只传音频与会话标识。
  voiceRealtime: {
    start: (payload: { callId: string; sessionId: string; dialogContext?: Array<{ role: 'user' | 'assistant'; text: string; timestamp?: number }> }) =>
      ipcRenderer.invoke('voice-realtime:start', payload) as Promise<{ success: boolean; callId?: string; error?: string }>,
    sendAudio: (callId: string, audio: Uint8Array) => ipcRenderer.send('voice-realtime:audio', callId, audio),
    truncate: (callId: string, replyId: string, audioEndMs: number) =>
      ipcRenderer.invoke('voice-realtime:truncate', callId, replyId, audioEndMs) as Promise<{ success: boolean; error?: string }>,
    stop: (callId: string) => ipcRenderer.invoke('voice-realtime:stop', callId) as Promise<{ success: boolean; error?: string }>,
    onEvent: (callId: string, callback: (event: unknown) => void): (() => void) => {
      const listener = (_event: unknown, payload: { callId?: string; event?: unknown }) => {
        if (payload?.callId === callId && payload.event) callback(payload.event)
      }
      ipcRenderer.on('voice-realtime:event', listener)
      return () => ipcRenderer.removeListener('voice-realtime:event', listener)
    },
  },

  // AI 作图 —— AI 助手 generate_image 工具
  imageGen: {
    getConfig: () => ipcRenderer.invoke('imageGen:getConfig') as Promise<{ success: boolean; config?: unknown; available?: boolean; error?: string }>,
    setConfig: (patch: unknown) => ipcRenderer.invoke('imageGen:setConfig', patch) as Promise<{ success: boolean; config?: unknown; error?: string }>,
    test: (cfg: unknown) => ipcRenderer.invoke('imageGen:test', cfg) as Promise<{ success: boolean; filePath?: string; mimeType?: string; error?: string }>,
  },

  // 数据库操作
  db: {
    open: (dbPath: string, key?: string) => ipcRenderer.invoke('db:open', dbPath, key),
    query: (sql: string, params?: any[]) => ipcRenderer.invoke('db:query', sql, params),
    close: () => ipcRenderer.invoke('db:close')
  },

  // 对话框
  dialog: {
    openFile: (options: any) => ipcRenderer.invoke('dialog:openFile', options),
    saveFile: (options: any) => ipcRenderer.invoke('dialog:saveFile', options)
  },

  // 文件操作
  file: {
    delete: (filePath: string) => ipcRenderer.invoke('file:delete', filePath),
    copy: (sourcePath: string, destPath: string) => ipcRenderer.invoke('file:copy', sourcePath, destPath),
    importHomeBackground: (sourcePath: string) => ipcRenderer.invoke('file:importHomeBackground', sourcePath),
    writeBase64: (filePath: string, base64Data: string) => ipcRenderer.invoke('file:writeBase64', filePath, base64Data)
  },

  // Shell
  shell: {
    openPath: (path: string) => ipcRenderer.invoke('shell:openPath', path),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    showItemInFolder: (fullPath: string) => ipcRenderer.invoke('shell:showItemInFolder', fullPath)
  },

  // App
  app: {
    getDownloadsPath: () => ipcRenderer.invoke('app:getDownloadsPath'),
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    getPlatformInfo: () => ipcRenderer.invoke('app:getPlatformInfo'),
    getMcpLaunchConfig: () => getMcpLaunchConfigSafe(),
    getUpdateState: () => ipcRenderer.invoke('app:getUpdateState'),
    getUpdateSourceInfo: () => ipcRenderer.invoke('app:getUpdateSourceInfo'),
    checkForUpdates: () => ipcRenderer.invoke('app:checkForUpdates'),
    downloadAndInstall: () => ipcRenderer.invoke('app:downloadAndInstall'),
    getStartupDbConnected: () => ipcRenderer.invoke('app:getStartupDbConnected'),
    onDownloadProgress: (callback: (progress: {
      percent: number
      transferred: number
      total: number
      bytesPerSecond: number
    }) => void) => {
      ipcRenderer.on('app:downloadProgress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('app:downloadProgress')
    },
    onUpdateAvailable: (callback: (info: {
      hasUpdate: boolean
      forceUpdate: boolean
      currentVersion: string
      version?: string
      releaseNotes?: string
      title?: string
      message?: string
      minimumSupportedVersion?: string
      reason?: 'minimum-version' | 'blocked-version'
      checkedAt: number
      updateSource: 'r2' | 'github' | 'custom' | 'none'
      policySource: 'r2' | 'github' | 'custom' | 'none'
    }) => void) => {
      ipcRenderer.on('app:updateAvailable', (_, info) => callback(info))
      return () => ipcRenderer.removeAllListeners('app:updateAvailable')
    }
  },

  // 窗口控制
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    openChatWindow: () => ipcRenderer.invoke('window:openChatWindow'),
    focusMainWindow: (route?: string) => ipcRenderer.invoke('window:focusMainWindow', route),
    openMomentsWindow: (filterUsername?: string) => ipcRenderer.invoke('window:openMomentsWindow', filterUsername),
    openPersonaChatWindow: (sessionId: string) => ipcRenderer.invoke('window:openPersonaChatWindow', sessionId),
    openPosterStyleWindow: () => ipcRenderer.invoke('window:openPosterStyleWindow'),
    onMomentsFilterUser: (callback: (username: string) => void) => {
      ipcRenderer.on('moments:filterUser', (_, username) => callback(username))
      return () => ipcRenderer.removeAllListeners('moments:filterUser')
    },
    onNavigate: (callback: (route: string) => void) => {
      const listener = (_: unknown, route: string) => callback(route)
      ipcRenderer.on('window:navigate', listener)
      return () => ipcRenderer.removeListener('window:navigate', listener)
    },
    openAgreementWindow: () => ipcRenderer.invoke('window:openAgreementWindow'),
    openPurchaseWindow: () => ipcRenderer.invoke('window:openPurchaseWindow'),
    openWelcomeWindow: (mode?: 'default' | 'add-account') => ipcRenderer.invoke('window:openWelcomeWindow', mode),
    completeWelcome: () => ipcRenderer.invoke('window:completeWelcome'),
    isChatWindowOpen: () => ipcRenderer.invoke('window:isChatWindowOpen'),
    closeChatWindow: () => ipcRenderer.invoke('window:closeChatWindow'),
    setTitleBarOverlay: (options: { hidden?: boolean; symbolColor?: string }) => ipcRenderer.send('window:setTitleBarOverlay', options),
    openImageViewerWindow: (
      imagePath: string,
      liveVideoPath?: string,
      imageList?: Array<{ imagePath: string; liveVideoPath?: string }>,
      options?: { sessionId?: string; imageMd5?: string; imageDatName?: string }
    ) => ipcRenderer.invoke('window:openImageViewerWindow', imagePath, liveVideoPath, imageList, options),
    openVideoPlayerWindow: (videoPath: string, videoWidth?: number, videoHeight?: number) => ipcRenderer.invoke('window:openVideoPlayerWindow', videoPath, videoWidth, videoHeight),
    openBrowserWindow: (url: string, title?: string) => ipcRenderer.invoke('window:openBrowserWindow', url, title),
    openSkillPreviewWindow: (skillName: string) => ipcRenderer.invoke('window:openSkillPreviewWindow', skillName) as Promise<boolean>,
    setReplyTileEnabled: (enabled: boolean) => ipcRenderer.invoke('window:setReplyTileEnabled', enabled) as Promise<boolean>,
    getReplyTileEnabled: () => ipcRenderer.invoke('window:getReplyTileEnabled') as Promise<boolean>,
    replyTileReady: () => ipcRenderer.send('window:replyTileReady'),
    replyTileRefresh: () => ipcRenderer.send('window:replyTileRefresh'),
    replyTile: {
      push: (entry: { sessionId: string; sessionName: string; avatarUrl?: string; state: 'pending' | 'loading' | 'error' | 'ready' | 'gone'; suggestions?: string[]; batches?: Array<{ id: string; targetKey: string; quote: string; suggestions: string[] }>; pendingContinue?: boolean; error?: string }) =>
        ipcRenderer.send('reply-tile:push', entry),
      continue: (sessionId: string) => ipcRenderer.send('reply-tile:continue', sessionId),
      skip: (sessionId: string) => ipcRenderer.send('reply-tile:skip', sessionId),
      retry: (payload: { sessionId: string; batchId: string; suggestionIndex: number }) => ipcRenderer.send('reply-tile:retry', payload),
      onUpdate: (callback: (entry: { sessionId: string; sessionName: string; avatarUrl?: string; state: 'pending' | 'loading' | 'error' | 'ready' | 'gone'; suggestions?: string[]; batches?: Array<{ id: string; targetKey: string; quote: string; suggestions: string[] }>; pendingContinue?: boolean; error?: string }) => void) => {
        const listener = (_: unknown, entry: any) => callback(entry)
        ipcRenderer.on('reply-tile:update', listener)
        return () => ipcRenderer.removeListener('reply-tile:update', listener)
      },
      onContinue: (callback: (sessionId: string) => void) => {
        const listener = (_: unknown, sessionId: string) => callback(sessionId)
        ipcRenderer.on('reply-tile:continue', listener)
        return () => ipcRenderer.removeListener('reply-tile:continue', listener)
      },
      onSkip: (callback: (sessionId: string) => void) => {
        const listener = (_: unknown, sessionId: string) => callback(sessionId)
        ipcRenderer.on('reply-tile:skip', listener)
        return () => ipcRenderer.removeListener('reply-tile:skip', listener)
      },
      onRetry: (callback: (payload: { sessionId: string; batchId: string; suggestionIndex: number }) => void) => {
        const listener = (_: unknown, payload: { sessionId: string; batchId: string; suggestionIndex: number }) => callback(payload)
        ipcRenderer.on('reply-tile:retry', listener)
        return () => ipcRenderer.removeListener('reply-tile:retry', listener)
      }
    },
    openChatHistoryWindow: (sessionId: string, messageId: number) => ipcRenderer.invoke('window:openChatHistoryWindow', sessionId, messageId),
    resizeToFitVideo: (videoWidth: number, videoHeight: number) => ipcRenderer.invoke('window:resizeToFitVideo', videoWidth, videoHeight),
    resizeContent: (width: number, height: number) => ipcRenderer.invoke('window:resizeContent', width, height),
    move: (x: number, y: number) => ipcRenderer.send('window:move', { x, y }),
    splashReady: () => ipcRenderer.send('window:splashReady'),
    onSplashFadeOut: (callback: () => void) => {
      ipcRenderer.on('splash:fadeOut', () => callback())
      return () => ipcRenderer.removeAllListeners('splash:fadeOut')
    },
    onImageListUpdate: (callback: (data: { imageList: Array<{ imagePath: string; liveVideoPath?: string }>, currentIndex: number }) => void) => {
      const listener = (_: any, data: any) => callback(data)
      ipcRenderer.on('imageViewer:setImageList', listener)
      return () => { ipcRenderer.removeListener('imageViewer:setImageList', listener) }
    }
  },

  systemAuth: {
    getStatus: () => ipcRenderer.invoke('systemAuth:getStatus') as Promise<{
      platform: string
      available: boolean
      method: 'windows-hello' | 'touch-id' | 'none'
      displayName: string
      error?: string
    }>,
    verify: (reason?: string) => ipcRenderer.invoke('systemAuth:verify', reason) as Promise<{
      success: boolean
      method: 'windows-hello' | 'touch-id' | 'none'
      error?: string
    }>
  },

  // 密钥获取
  wxKey: {
    isWeChatRunning: () => ipcRenderer.invoke('wxkey:isWeChatRunning'),
    getWeChatPid: () => ipcRenderer.invoke('wxkey:getWeChatPid'),
    killWeChat: () => ipcRenderer.invoke('wxkey:killWeChat'),
    launchWeChat: () => ipcRenderer.invoke('wxkey:launchWeChat'),
    waitForWindow: (maxWaitSeconds?: number) => ipcRenderer.invoke('wxkey:waitForWindow', maxWaitSeconds),
    startGetKey: (customWechatPath?: string, dbPath?: string) => ipcRenderer.invoke('wxkey:startGetKey', customWechatPath, dbPath),
    cancel: () => ipcRenderer.invoke('wxkey:cancel'),
    detectCurrentAccount: (dbPath?: string, maxTimeDiffMinutes?: number) => ipcRenderer.invoke('wxkey:detectCurrentAccount', dbPath, maxTimeDiffMinutes),
    onStatus: (callback: (data: { status: string; level: number }) => void) => {
      ipcRenderer.on('wxkey:status', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('wxkey:status')
    }
  },

  // 数据库路径
  dbPath: {
    autoDetect: () => ipcRenderer.invoke('dbpath:autoDetect'),
    scanWxids: (rootPath: string) => ipcRenderer.invoke('dbpath:scanWxids', rootPath),
    getDefault: () => ipcRenderer.invoke('dbpath:getDefault'),
    getBestCachePath: () => ipcRenderer.invoke('dbpath:getBestCachePath')
  },

  // WCDB 数据库
  wcdb: {
    testConnection: (dbPath: string, hexKey: string, wxid: string, isAutoConnect?: boolean) =>
      ipcRenderer.invoke('wcdb:testConnection', dbPath, hexKey, wxid, isAutoConnect),
    resolveValidWxid: (dbPath: string, hexKey: string) =>
      ipcRenderer.invoke('wcdb:resolveValidWxid', dbPath, hexKey),
    open: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:open', dbPath, hexKey, wxid),
    close: () => ipcRenderer.invoke('wcdb:close'),
    decryptDatabase: (dbPath: string, hexKey: string, wxid: string) =>
      ipcRenderer.invoke('wcdb:decryptDatabase', dbPath, hexKey, wxid),
    onDecryptProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('wcdb:decryptProgress', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('wcdb:decryptProgress')
    },
    onChange: (callback: (payload: { table: string; dbPath: string; walPath: string }) => void) => {
      const listener = (_: any, payload: any) => callback(payload)
      ipcRenderer.on('wcdb:change', listener)
      return () => ipcRenderer.removeListener('wcdb:change', listener)
    }
  },

  // 数据管理
  dataManagement: {
    scanDatabases: () => ipcRenderer.invoke('dataManagement:scanDatabases'),
    decryptAll: () => ipcRenderer.invoke('dataManagement:decryptAll'),
    decryptSingleDatabase: (filePath: string) => ipcRenderer.invoke('dataManagement:decryptSingleDatabase', filePath),
    incrementalUpdate: () => ipcRenderer.invoke('dataManagement:incrementalUpdate'),
    getCurrentCachePath: () => ipcRenderer.invoke('dataManagement:getCurrentCachePath'),
    getDefaultCachePath: () => ipcRenderer.invoke('dataManagement:getDefaultCachePath'),
    migrateCache: (newCachePath: string) => ipcRenderer.invoke('dataManagement:migrateCache', newCachePath),
    scanImages: (dirPath: string) => ipcRenderer.invoke('dataManagement:scanImages', dirPath),
    decryptImages: (dirPath: string) => ipcRenderer.invoke('dataManagement:decryptImages', dirPath),
    getImageDirectories: () => ipcRenderer.invoke('dataManagement:getImageDirectories'),
    decryptSingleImage: (filePath: string) => ipcRenderer.invoke('dataManagement:decryptSingleImage', filePath),
    checkForUpdates: () => ipcRenderer.invoke('dataManagement:checkForUpdates'),
    enableAutoUpdate: (intervalSeconds?: number) => ipcRenderer.invoke('dataManagement:enableAutoUpdate', intervalSeconds),
    disableAutoUpdate: () => ipcRenderer.invoke('dataManagement:disableAutoUpdate'),
    autoIncrementalUpdate: (silent?: boolean) => ipcRenderer.invoke('dataManagement:autoIncrementalUpdate', silent),
    onProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('dataManagement:progress', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('dataManagement:progress')
    },
    onUpdateAvailable: (callback: (hasUpdate: boolean) => void) => {
      ipcRenderer.on('dataManagement:updateAvailable', (_, hasUpdate) => callback(hasUpdate))
      return () => ipcRenderer.removeAllListeners('dataManagement:updateAvailable')
    }
  },

  // 图片解密
  imageDecrypt: {
    batchDetectXorKey: (dirPath: string) => ipcRenderer.invoke('imageDecrypt:batchDetectXorKey', dirPath),
    decryptImage: (inputPath: string, outputPath: string, xorKey: number, aesKey?: string) =>
      ipcRenderer.invoke('imageDecrypt:decryptImage', inputPath, outputPath, xorKey, aesKey)
  },

  // 图片解密（新 API）
  image: {
    decrypt: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number; force?: boolean; quick?: boolean }) =>
      ipcRenderer.invoke('image:decrypt', payload),
    resolveCache: (payload: { sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }) =>
      ipcRenderer.invoke('image:resolveCache', payload),
    prewarm: (payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>) =>
      ipcRenderer.invoke('image:prewarm', payloads),
    batchDecrypt: (payloads: Array<{ sessionId?: string; imageMd5?: string; imageDatName?: string; createTime?: number }>) =>
      ipcRenderer.invoke('image:batchDecrypt', payloads),
    onBatchDecryptProgress: (callback: (data: { current: number; total: number; successCount: number; failCount: number; cacheHits: number; decrypted: number; skipped: number }) => void) => {
      const listener = (_: Electron.IpcRendererEvent, data: { current: number; total: number; successCount: number; failCount: number; cacheHits: number; decrypted: number; skipped: number }) => callback(data)
      ipcRenderer.on('image:batchDecryptProgress', listener)
      return () => { ipcRenderer.removeListener('image:batchDecryptProgress', listener) }
    },
    onUpdateAvailable: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string }) => void) => {
      ipcRenderer.on('image:updateAvailable', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('image:updateAvailable')
    },
    onCacheResolved: (callback: (data: { cacheKey: string; imageMd5?: string; imageDatName?: string; localPath: string }) => void) => {
      ipcRenderer.on('image:cacheResolved', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('image:cacheResolved')
    },
    deleteThumbnails: () => ipcRenderer.invoke('image:deleteThumbnails'),
    countThumbnails: () => ipcRenderer.invoke('image:countThumbnails'),
  },

  // 视频
  video: {
    getVideoInfo: (videoMd5: string, rawContent?: string) => ipcRenderer.invoke('video:getVideoInfo', videoMd5, rawContent),
    readFile: (videoPath: string) => ipcRenderer.invoke('video:readFile', videoPath),
    parseVideoMd5: (content: string) => ipcRenderer.invoke('video:parseVideoMd5', content),
    parseChannelVideo: (content: string) => ipcRenderer.invoke('video:parseChannelVideo', content),
    downloadChannelVideo: (videoInfo: any, key?: string) => ipcRenderer.invoke('video:downloadChannelVideo', videoInfo, key),
    onDownloadProgress: (callback: (progress: any) => void) => {
      const listener = (_: any, progress: any) => callback(progress)
      ipcRenderer.on('video:downloadProgress', listener)
      return () => ipcRenderer.removeListener('video:downloadProgress', listener)
    }
  },


  // 图片密钥获取
  imageKey: {
    getImageKeys: (userDir: string) => ipcRenderer.invoke('imageKey:getImageKeys', userDir),
    onProgress: (callback: (msg: string) => void) => {
      ipcRenderer.on('imageKey:progress', (_, msg) => callback(msg))
      return () => ipcRenderer.removeAllListeners('imageKey:progress')
    }
  },

  // 聊天
  chat: {
    connect: () => ipcRenderer.invoke('chat:connect'),
    getSessions: (offset?: number, limit?: number) => ipcRenderer.invoke('chat:getSessions', offset, limit),
    searchSessions: (keyword: string) => ipcRenderer.invoke('chat:searchSessions', keyword),
    getMentionTargets: (offset?: number, limit?: number, keyword?: string) => ipcRenderer.invoke('chat:getMentionTargets', offset, limit, keyword),
    getContacts: () => ipcRenderer.invoke('chat:getContacts'),
    getMessages: (sessionId: string, offset?: number, limit?: number) =>
      ipcRenderer.invoke('chat:getMessages', sessionId, offset, limit),
    getMessagesBefore: (
      sessionId: string,
      cursorSortSeq: number,
      limit?: number,
      cursorCreateTime?: number,
      cursorLocalId?: number
    ) =>
      ipcRenderer.invoke('chat:getMessagesBefore', sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId),
    getMessagesAfter: (
      sessionId: string,
      cursorSortSeq: number,
      limit?: number,
      cursorCreateTime?: number,
      cursorLocalId?: number
    ) =>
      ipcRenderer.invoke('chat:getMessagesAfter', sessionId, cursorSortSeq, limit, cursorCreateTime, cursorLocalId),
    getNewMessages: (sessionId: string, minTime: number, limit?: number) =>
      ipcRenderer.invoke('chat:getNewMessages', sessionId, minTime, limit),
    getAllVoiceMessages: (sessionId: string) =>
      ipcRenderer.invoke('chat:getAllVoiceMessages', sessionId),
    getAllImageMessages: (sessionId: string) =>
      ipcRenderer.invoke('chat:getAllImageMessages', sessionId),
    getImageData: (sessionId: string, msgId: string, createTime?: number) =>
      ipcRenderer.invoke('chat:getImageData', sessionId, msgId, createTime),
    getContact: (username: string) => ipcRenderer.invoke('chat:getContact', username),
    getContactAvatar: (username: string) => ipcRenderer.invoke('chat:getContactAvatar', username),
    resolveTransferDisplayNames: (chatroomId: string, payerUsername: string, receiverUsername: string) =>
      ipcRenderer.invoke('chat:resolveTransferDisplayNames', chatroomId, payerUsername, receiverUsername),
    getMyAvatarUrl: () => ipcRenderer.invoke('chat:getMyAvatarUrl'),
    getMyUserInfo: () => ipcRenderer.invoke('chat:getMyUserInfo'),
    downloadEmoji: (cdnUrl: string, md5?: string, productId?: string, createTime?: number, encryptUrl?: string, aesKey?: string) => ipcRenderer.invoke('chat:downloadEmoji', cdnUrl, md5, productId, createTime, encryptUrl, aesKey),
    close: () => ipcRenderer.invoke('chat:close'),
    refreshCache: () => ipcRenderer.invoke('chat:refreshCache'),
    setCurrentSession: (sessionId: string | null) => ipcRenderer.invoke('chat:setCurrentSession', sessionId),
    getSessionDetail: (sessionId: string) => ipcRenderer.invoke('chat:getSessionDetail', sessionId),
    getVoiceData: (sessionId: string, msgId: string, createTime?: number, serverId?: number) => ipcRenderer.invoke('chat:getVoiceData', sessionId, msgId, createTime, serverId),
    getMessagesByDate: (sessionId: string, targetTimestamp: number, limit?: number) =>
      ipcRenderer.invoke('chat:getMessagesByDate', sessionId, targetTimestamp, limit),
    getMessage: (sessionId: string, localId: number) => ipcRenderer.invoke('chat:getMessage', sessionId, localId),
    pickRandomMomentFromIndex: () =>
      ipcRenderer.invoke('chat:pickRandomMomentFromIndex'),
    getDatesWithMessages: (sessionId: string, year: number, month: number) =>
      ipcRenderer.invoke('chat:getDatesWithMessages', sessionId, year, month),
    onSessionsUpdated: (callback: (sessions: any[]) => void) => {
      const listener = (_: any, sessions: any[]) => callback(sessions)
      ipcRenderer.on('chat:sessions-updated', listener)
      return () => ipcRenderer.removeListener('chat:sessions-updated', listener)
    },
    onNewMessages: (callback: (data: { sessionId: string; messages: any[] }) => void) => {
      const listener = (_: any, data: any) => callback(data)
      ipcRenderer.on('chat:new-messages', listener)
      return () => ipcRenderer.removeListener('chat:new-messages', listener)
    }
  },

  // 朋友圈
  sns: {
    getTimeline: (limit?: number, offset?: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number) =>
      ipcRenderer.invoke('sns:getTimeline', limit || 20, offset || 0, usernames, keyword, startTime, endTime),
    proxyImage: (params: { url: string; key?: string | number }) =>
      ipcRenderer.invoke('sns:proxyImage', params),
    downloadImage: (params: { url: string; key?: string | number }) =>
      ipcRenderer.invoke('sns:downloadImage', params),
    downloadEmoji: (params: { url: string; encryptUrl?: string; aesKey?: string }) =>
      ipcRenderer.invoke('sns:downloadEmoji', params),
    writeExportFile: (filePath: string, content: string) =>
      ipcRenderer.invoke('sns:writeExportFile', filePath, content),
    saveMediaToDir: (params: { url: string; key?: string | number; outputDir: string; index: number; md5?: string; isAvatar?: boolean; username?: string; isEmoji?: boolean; encryptUrl?: string; aesKey?: string }) =>
      ipcRenderer.invoke('sns:saveMediaToDir', params)
  },

  // 导出
  export: {
    exportSessions: (sessionIds: string[], outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportSessions', sessionIds, outputDir, options),
    exportSession: (sessionId: string, outputPath: string, options: any) =>
      ipcRenderer.invoke('export:exportSession', sessionId, outputPath, options),
    exportContacts: (outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportContacts', outputDir, options),
    exportMoments: (outputDir: string, options: any) =>
      ipcRenderer.invoke('export:exportMoments', outputDir, options),
    scanDatabases: () =>
      ipcRenderer.invoke('export:scanDatabases'),
    exportDatabases: (selectedPaths: string[], outputDir: string) =>
      ipcRenderer.invoke('export:exportDatabases', selectedPaths, outputDir),
    onProgress: (callback: (data: any) => void) => {
      ipcRenderer.on('export:progress', (_, data) => callback(data))
      return () => ipcRenderer.removeAllListeners('export:progress')
    }
  },

  // 激活
  activation: {
    getDeviceId: () => ipcRenderer.invoke('activation:getDeviceId'),
    verifyCode: (code: string) => ipcRenderer.invoke('activation:verifyCode', code),
    activate: (code: string) => ipcRenderer.invoke('activation:activate', code),
    checkStatus: () => ipcRenderer.invoke('activation:checkStatus'),
    getTypeDisplayName: (type: string | null) => ipcRenderer.invoke('activation:getTypeDisplayName', type),
    clearCache: () => ipcRenderer.invoke('activation:clearCache')
  },
  cache: {
    clearImages: () => ipcRenderer.invoke('cache:clearImages'),
    clearEmojis: () => ipcRenderer.invoke('cache:clearEmojis'),
    clearDatabases: () => ipcRenderer.invoke('cache:clearDatabases'),
    clearAIData: () => ipcRenderer.invoke('cache:clearAIData'),
    clearAll: () => ipcRenderer.invoke('cache:clearAll'),
    clearConfig: () => ipcRenderer.invoke('cache:clearConfig'),
    clearCurrentAccount: (deleteLocalData?: boolean) => ipcRenderer.invoke('cache:clearCurrentAccount', deleteLocalData),
    clearAllAccountConfigs: () => ipcRenderer.invoke('cache:clearAllAccountConfigs'),
    getCacheSize: () => ipcRenderer.invoke('cache:getCacheSize')
  },
  log: {
    getLogFiles: () => ipcRenderer.invoke('log:getLogFiles'),
    readLogFile: (filename: string) => ipcRenderer.invoke('log:readLogFile', filename),
    clearLogs: () => ipcRenderer.invoke('log:clearLogs'),
    getLogSize: () => ipcRenderer.invoke('log:getLogSize'),
    getLogDirectory: () => ipcRenderer.invoke('log:getLogDirectory'),
    setLogLevel: (level: string) => ipcRenderer.invoke('log:setLogLevel', level),
    getLogLevel: () => ipcRenderer.invoke('log:getLogLevel')
  },

  // 语音转文字 (STT)
  stt: {
    getModelStatus: () => ipcRenderer.invoke('stt:getModelStatus'),
    downloadModel: () => ipcRenderer.invoke('stt:downloadModel'),
    cancelDownloadModel: () => ipcRenderer.invoke('stt:cancelDownloadModel'),
    transcribe: (wavBase64: string, sessionId: string, createTime: number, force?: boolean, localId?: number) => ipcRenderer.invoke('stt:transcribe', wavBase64, sessionId, createTime, force, localId),
    transcribeBuffer: (wavBase64: string) => ipcRenderer.invoke('stt:transcribeBuffer', wavBase64),
    testOnlineConfig: (overrides?: { provider?: 'openai-compatible' | 'aliyun-qwen-asr' | 'qianwen-cloud' | 'volcano-doubao' | 'custom'; apiKey?: string; baseURL?: string; model?: string; language?: string; timeoutMs?: number }) =>
      ipcRenderer.invoke('stt-online:test-config', overrides),
    onDownloadProgress: (callback: (progress: { modelName: string; downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => {
      ipcRenderer.on('stt:downloadProgress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('stt:downloadProgress')
    },
    onPartialResult: (callback: (text: string) => void) => {
      ipcRenderer.on('stt:partialResult', (_, text) => callback(text))
      return () => ipcRenderer.removeAllListeners('stt:partialResult')
    },
    getCachedTranscript: (sessionId: string, createTime: number, localId?: number) => ipcRenderer.invoke('stt:getCachedTranscript', sessionId, createTime, localId),
    updateTranscript: (sessionId: string, createTime: number, transcript: string, localId?: number) => ipcRenderer.invoke('stt:updateTranscript', sessionId, createTime, transcript, localId),
    clearModel: () => ipcRenderer.invoke('stt:clearModel')
  },

  // 语音转文字 - Whisper GPU 加速
  sttWhisper: {
    detectGPU: () => ipcRenderer.invoke('stt-whisper:detect-gpu'),
    checkModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:check-model', modelType),
    downloadModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:download-model', modelType),
    cancelDownloadModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:cancel-download-model', modelType),
    clearModel: (modelType: string) => ipcRenderer.invoke('stt-whisper:clear-model', modelType),
    transcribe: (wavData: Buffer | ArrayBuffer | Uint8Array, options: { modelType?: string; language?: string }) =>
      ipcRenderer.invoke('stt-whisper:transcribe', wavData, options),
    onDownloadProgress: (callback: (progress: { downloadedBytes: number; totalBytes?: number; percent?: number }) => void) => {
      ipcRenderer.on('stt-whisper:download-progress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('stt-whisper:download-progress')
    },
    downloadGPUComponents: () => ipcRenderer.invoke('stt-whisper:download-gpu-components'),
    cancelDownloadGPUComponents: () => ipcRenderer.invoke('stt-whisper:cancel-download-gpu-components'),
    checkGPUComponents: () => ipcRenderer.invoke('stt-whisper:check-gpu-components'),
    onGPUDownloadProgress: (callback: (progress: { currentFile: string; fileProgress: number; overallProgress: number; completedFiles: number; totalFiles: number }) => void) => {
      ipcRenderer.on('stt-whisper:gpu-download-progress', (_, progress) => callback(progress))
      return () => ipcRenderer.removeAllListeners('stt-whisper:gpu-download-progress')
    }
  },

  // AI 接入
  ai: {
    getProviders: () => ipcRenderer.invoke('ai:getProviders'),
    getProxyStatus: () => ipcRenderer.invoke('ai:getProxyStatus'),
    refreshProxy: () => ipcRenderer.invoke('ai:refreshProxy'),
    testProxy: (proxyUrl: string, testUrl?: string) => ipcRenderer.invoke('ai:testProxy', proxyUrl, testUrl),
    testConnection: (provider: string, apiKey: string, baseURL?: string, protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription', model?: string) => ipcRenderer.invoke('ai:testConnection', provider, apiKey, baseURL, protocol, model),
    listModels: (options: { provider: string; apiKey?: string; baseURL?: string; protocol?: 'openai-responses' | 'openai-compatible' | 'anthropic' | 'google' | 'codex-subscription' }) => ipcRenderer.invoke('ai:listModels', options),
    estimateCost: (messageCount: number, provider: string) => ipcRenderer.invoke('ai:estimateCost', messageCount, provider),
    readGuide: (guideName: string) => ipcRenderer.invoke('ai:readGuide', guideName)
  },

  codexSubscription: {
    getStatus: () => ipcRenderer.invoke('codexSubscription:getStatus'),
    getUsage: (forceRefresh?: boolean) => ipcRenderer.invoke('codexSubscription:getUsage', forceRefresh),
    login: () => ipcRenderer.invoke('codexSubscription:login'),
    importFromCodexCli: () => ipcRenderer.invoke('codexSubscription:importFromCodexCli'),
    listAccounts: () => ipcRenderer.invoke('codexSubscription:listAccounts'),
    setActiveAccount: (id: string) => ipcRenderer.invoke('codexSubscription:setActiveAccount', id),
    removeAccount: (id: string) => ipcRenderer.invoke('codexSubscription:removeAccount', id),
    logout: () => ipcRenderer.invoke('codexSubscription:logout'),
    listModels: () => ipcRenderer.invoke('codexSubscription:listModels'),
    onStatusChanged: (callback: (status: unknown) => void): (() => void) => {
      const listener = (_event: unknown, status: unknown) => callback(status)
      ipcRenderer.on('codexSubscription:statusChanged', listener)
      return () => ipcRenderer.removeListener('codexSubscription:statusChanged', listener)
    },
  }
})

  // 主题由 index.html 中的内联脚本处理，这里只负责同步 localStorage
  ; (async () => {
    try {
      const theme = await ipcRenderer.invoke('config:get', 'theme') || 'cloud-dancer'
      const themeMode = await ipcRenderer.invoke('config:get', 'themeMode') || 'system'

      // 更新 localStorage 以供下次同步使用（主窗口场景）
      try {
        localStorage.setItem('theme', theme)
        localStorage.setItem('themeMode', themeMode)
      } catch (e) {
        // localStorage 可能不可用
      }
    } catch (e) {
      // 忽略错误
    }
  })()
