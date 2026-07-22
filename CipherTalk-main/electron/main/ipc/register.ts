import type { MainProcessContext } from '../context'
import { registerAccountHandlers } from './accountHandlers'
import { registerActivationHandlers } from './activationHandlers'
import { registerAgentCanvasHandlers } from './agentCanvasHandlers'
import { registerAgentWorkspaceHandlers } from './agentWorkspaceHandlers'
import { registerAiHandlers } from './aiHandlers'
import { registerAppHandlers } from './appHandlers'
import { registerAppUpdateHandlers } from './appUpdateHandlers'
import { registerAuthHandlers } from './authHandlers'
import { registerCacheHandlers } from './cacheHandlers'
import { registerChatHandlers } from './chatHandlers'
import { registerCodexSubscriptionHandlers } from './codexSubscriptionHandlers'
import { registerConfigHandlers } from './configHandlers'
import { registerDataManagementHandlers } from './dataManagementHandlers'
import { registerDataHandlers } from './dataHandlers'
import { registerDeviceConnectHandlers } from './deviceConnectHandlers'
import { registerDbPathHandlers } from './dbPathHandlers'
import { registerExportHandlers } from './exportHandlers'
import { registerLogHandlers } from './logHandlers'
import { registerLocalCodingAgentHandlers } from './localCodingAgentHandlers'
import { registerMediaHandlers } from './mediaHandlers'
import { registerMcpHandlers } from './mcpHandlers'
import { registerNotifyHandlers } from './notifyHandlers'
import { registerPetHandlers } from './petHandlers'
import { registerPluginHandlers } from './pluginHandlers'
import { registerSnsHandlers } from './snsHandlers'
import { registerSkillHandlers } from './skillHandlers'
import { registerSttHandlers } from './sttHandlers'
import { registerSystemHandlers } from './systemHandlers'
import { registerWcdbHandlers } from './wcdbHandlers'
import { registerWindowHandlers } from './windowHandlers'
import { registerWxKeyHandlers } from './wxKeyHandlers'
import { registerVoiceRealtimeHandlers } from './voiceRealtimeHandlers'

export function registerModularIpcHandlers(ctx: MainProcessContext): void {
  registerConfigHandlers(ctx)
  registerAccountHandlers(ctx)
  registerSkillHandlers(ctx)
  registerMcpHandlers()
  registerDataHandlers(ctx)
  registerSystemHandlers()
  registerAppHandlers(ctx)
  registerAppUpdateHandlers(ctx)
  registerAuthHandlers(ctx)
  registerWindowHandlers(ctx)
  registerWxKeyHandlers(ctx)
  registerDbPathHandlers(ctx)
  registerWcdbHandlers(ctx)
  registerDataManagementHandlers(ctx)
  registerMediaHandlers(ctx)
  registerChatHandlers(ctx)
  registerCodexSubscriptionHandlers(ctx)
  registerSnsHandlers(ctx)
  registerExportHandlers(ctx)
  registerActivationHandlers(ctx)
  registerCacheHandlers(ctx)
  registerLogHandlers(ctx)
  registerLocalCodingAgentHandlers(ctx)
  registerSttHandlers(ctx)
  registerVoiceRealtimeHandlers()
  registerAiHandlers(ctx)
  registerAgentWorkspaceHandlers(ctx)
  registerAgentCanvasHandlers(ctx)
  registerPetHandlers(ctx)
  registerPluginHandlers(ctx)
  registerNotifyHandlers(ctx)
  registerDeviceConnectHandlers(ctx)
}
