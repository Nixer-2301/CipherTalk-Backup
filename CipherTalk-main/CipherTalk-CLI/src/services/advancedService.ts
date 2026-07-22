import { searchMessages } from './searchService.js'
import { exportChat as runExportChat } from './export/exportService.js'
import { runMcpServe } from './mcp/runtime.js'
import { getMomentsTimeline } from './sns/snsService.js'
import type {
  AdvancedService,
  SearchResult,
  ExportOptions,
  MomentsOptions,
  MomentsResult
} from './types.js'
import type { RuntimeConfig } from '../types.js'

export class RealAdvancedService implements AdvancedService {
  async search(
    config: RuntimeConfig,
    keyword: string,
    options?: { session?: string; limit?: number; from?: string; to?: string }
  ): Promise<SearchResult> {
    return searchMessages(config, keyword, options || {})
  }

  async exportChat(config: RuntimeConfig, opts: ExportOptions): Promise<{ path: string; count: number }> {
    return runExportChat(config, opts)
  }

  async moments(config: RuntimeConfig, options: MomentsOptions = {}): Promise<MomentsResult> {
    return getMomentsTimeline(config, options)
  }

  async mcpServe(): Promise<never> {
    return runMcpServe()
  }
}

export const advancedService = new RealAdvancedService()
