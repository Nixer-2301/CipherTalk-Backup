import { EventEmitter } from 'node:events'
import { WcdbCore } from './wcdbCore.js'
import { getNativeRoot, getUserDataPath } from '../../runtimePaths.js'

type QueryResult = { success: boolean; rows?: any[]; error?: string }

export class WcdbService extends EventEmitter {
  private readonly core = new WcdbCore()

  constructor() {
    super()
    this.core.setPaths(getNativeRoot(), getUserDataPath())
  }

  async testConnection(dbPath: string, hexKey: string, wxid = ''): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    this.core.setPaths(getNativeRoot(), getUserDataPath())
    return this.core.testConnection(dbPath, hexKey, wxid)
  }

  async open(dbPath: string, hexKey: string, wxid = ''): Promise<boolean> {
    this.core.setPaths(getNativeRoot(), getUserDataPath())
    return this.core.open(dbPath, hexKey, wxid)
  }

  close(): void {
    this.core.close()
  }

  shutdown(): void {
    this.core.shutdown()
  }

  isConnected(): boolean {
    return this.core.isConnected()
  }

  async execQuery(kind: string, path: string, sql: string): Promise<QueryResult> {
    return this.core.execQuery(kind, path, sql)
  }

  async execQueryWithParams(kind: string, path: string, sql: string, params?: any[]): Promise<QueryResult> {
    return this.core.execQueryWithParams(kind, path, sql, params)
  }

  async getSnsTimeline(
    limit: number,
    offset: number,
    usernames?: string[],
    keyword?: string,
    startTime?: number,
    endTime?: number
  ): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    return this.core.getSnsTimeline(limit, offset, usernames, keyword, startTime, endTime)
  }

  async getNativeMessages(sessionId: string, limit: number, offset: number): Promise<QueryResult> {
    return this.core.getNativeMessages(sessionId, limit, offset)
  }
}

export const wcdbService = new WcdbService()
