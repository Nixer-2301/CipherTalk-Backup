import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { ConfigService } from '../config'

export type AgentAuditRisk = 'low' | 'medium' | 'high'
export type AgentAuditStatus = 'pending' | 'approved' | 'denied' | 'success' | 'failed' | 'rolled_back'

export interface AgentAuditRecord {
  operationId: string
  source: 'agent' | 'code-workspace' | 'task' | 'system'
  toolName: string
  argsSummary?: string
  risk: AgentAuditRisk
  status: AgentAuditStatus
  targetPath?: string
  snapshotPath?: string
  outputPaths?: string[]
  error?: string
  createdAt: number
  updatedAt: number
}

function now(): number {
  return Date.now()
}

function getBaseDir(): string {
  const config = new ConfigService()
  try {
    const dir = path.join(config.getCacheBasePath(), 'agent-audit')
    fs.mkdirSync(dir, { recursive: true })
    fs.mkdirSync(path.join(dir, 'snapshots'), { recursive: true })
    return dir
  } finally {
    config.close()
  }
}

function readJsonl(filePath: string): AgentAuditRecord[] {
  if (!fs.existsSync(filePath)) return []
  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as AgentAuditRecord
      } catch {
        return null
      }
    })
    .filter((item): item is AgentAuditRecord => Boolean(item))
}

function safeSummary(value: unknown, max = 1200): string {
  let text = ''
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value ?? '')
  }
  return text.length > max ? `${text.slice(0, max)}...<truncated>` : text
}

export class AgentAuditService {
  private get logPath(): string {
    return path.join(getBaseDir(), 'operations.jsonl')
  }

  createSnapshot(targetPath: string): string | undefined {
    try {
      const stat = fs.statSync(targetPath)
      if (!stat.isFile()) return undefined
      const ext = path.extname(targetPath)
      const snapshotPath = path.join(
        getBaseDir(),
        'snapshots',
        `${Date.now()}-${crypto.randomBytes(5).toString('hex')}${ext || '.snapshot'}`,
      )
      fs.copyFileSync(targetPath, snapshotPath)
      return snapshotPath
    } catch {
      return undefined
    }
  }

  record(input: Omit<AgentAuditRecord, 'operationId' | 'createdAt' | 'updatedAt' | 'argsSummary'> & {
    operationId?: string
    argsSummary?: unknown
  }): AgentAuditRecord {
    const at = now()
    const record: AgentAuditRecord = {
      operationId: input.operationId || `op-${at}-${crypto.randomBytes(4).toString('hex')}`,
      source: input.source,
      toolName: input.toolName,
      argsSummary: input.argsSummary ? safeSummary(input.argsSummary) : undefined,
      risk: input.risk,
      status: input.status,
      targetPath: input.targetPath,
      snapshotPath: input.snapshotPath,
      outputPaths: input.outputPaths,
      error: input.error,
      createdAt: at,
      updatedAt: at,
    }
    fs.appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, 'utf8')
    return record
  }

  list(limit = 50): AgentAuditRecord[] {
    const capped = Math.max(1, Math.min(200, Number(limit) || 50))
    return readJsonl(this.logPath)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, capped)
  }

  find(operationId: string): AgentAuditRecord | null {
    return readJsonl(this.logPath).reverse().find((record) => record.operationId === operationId) || null
  }

  rollback(operationId: string, confirmed = false): Record<string, unknown> {
    const record = this.find(operationId)
    if (!record) return { success: false, error: '未找到审计记录' }
    if (!record.snapshotPath || !record.targetPath) {
      return { success: false, error: '该操作没有可用快照，无法回滚' }
    }
    if (!fs.existsSync(record.snapshotPath)) return { success: false, error: '快照文件不存在，无法回滚' }
    if (!confirmed) {
      return {
        success: false,
        requiresConfirmation: true,
        operationId,
        targetPath: record.targetPath,
        snapshotPath: record.snapshotPath,
        message: '回滚会覆盖当前目标文件。确认后请再次调用 confirmed=true。',
      }
    }
    const rollbackSnapshot = this.createSnapshot(record.targetPath)
    fs.mkdirSync(path.dirname(record.targetPath), { recursive: true })
    fs.copyFileSync(record.snapshotPath, record.targetPath)
    const rollbackRecord = this.record({
      source: 'agent',
      toolName: 'rollback_operation',
      argsSummary: { operationId },
      risk: 'high',
      status: 'rolled_back',
      targetPath: record.targetPath,
      snapshotPath: rollbackSnapshot,
      outputPaths: [record.targetPath],
    })
    return { success: true, operationId, rollbackOperationId: rollbackRecord.operationId, restoredPath: record.targetPath }
  }
}

export const agentAuditService = new AgentAuditService()
