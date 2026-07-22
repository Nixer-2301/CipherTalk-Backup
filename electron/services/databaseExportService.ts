/**
 * DatabaseExportService —— 把微信原生【加密】数据库解密落地为普通 SQLite 库。
 *
 * 原生 wcdb_api 不提供字节级解密符号，故走「逻辑拷贝」：经 dbAdapter（绝对路径 + 账号密钥）
 * 逐表读出 → 用 better-sqlite3 写入新明文库。
 *
 * 忠实性：native 把 BLOB 序列化为 hex 字符串、整数为 JSON number（int64 丢精度），且 JSON 里
 * TEXT/BLOB 无法区分。为此复制时用 SQLite 的 quote() 逐列取值——返回带类型、无精度损失的
 * SQL 字面量（NULL / 12345 / 1.5 / 'text' / X'0a1b'），原样拼成 INSERT 在明文库执行，
 * BLOB / int64 / text / real / null 全部忠实还原。
 */
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { basename, dirname, join, relative } from 'path'
import { dbAdapter } from './dbAdapter'
import { getDbStoragePath } from './dbStoragePaths'
import { ConfigService } from './config'

export interface DatabaseFileInfo {
  path: string
  name: string
  relativePath: string
  folder: string
  size: number
}

export interface DatabaseScanResult {
  success: boolean
  root?: string
  databases?: DatabaseFileInfo[]
  error?: string
}

export interface DatabaseExportProgress {
  current: number
  total: number
  currentSession: string // 复用现有 export:progress 字段名，这里是库名
  detail: string // 当前表名
  phase: string
}

export interface DatabaseTableError {
  db: string
  table: string
  error: string
}

export interface DatabaseExportResult {
  success: boolean
  successCount?: number
  failCount?: number
  error?: string
  outputDir?: string
  tableErrors?: DatabaseTableError[]
}

// path 为绝对路径时原生会忽略 kind，这里给个占位值即可
const QUERY_KIND = 'message'
const SELECT_BATCH = 1000
const INSERT_CHUNK = 200

function quoteIdent(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`
}

function walkDbFiles(root: string, depth = 0, acc: string[] = []): string[] {
  if (depth > 6) return acc
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isFile()) {
      // 只收 .db 本体；.db-wal / .db-shm / .db-journal 因不以 .db 结尾自然被排除
      if (entry.name.toLowerCase().endsWith('.db')) acc.push(full)
    } else if (entry.isDirectory()) {
      walkDbFiles(full, depth + 1, acc)
    }
  }
  return acc
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

function formatTimestamp(): string {
  const d = new Date()
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
  )
}

class DatabaseExportService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  /** 扫描 db_storage 下所有 .db 文件（含体积），供前端左侧列出勾选。 */
  async scanDatabases(): Promise<DatabaseScanResult> {
    try {
      const root = getDbStoragePath()
      if (!root) {
        return { success: false, error: '未找到 db_storage 目录，请先在设置中配置微信数据目录' }
      }
      const files = walkDbFiles(root)
      const databases: DatabaseFileInfo[] = files
        .map((p) => {
          let size = 0
          try {
            size = statSync(p).size
          } catch {
            /* ignore */
          }
          const rel = relative(root, p).replace(/\\/g, '/')
          const dir = dirname(rel)
          return {
            path: p,
            name: basename(p),
            relativePath: rel,
            folder: dir === '.' ? '' : dir,
            size
          }
        })
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
      return { success: true, root, databases }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  /** 把选中的加密库逐个解密落地为明文 SQLite，每库一个同名 .db。 */
  async exportDatabases(
    selectedPaths: string[],
    outputDir: string,
    onProgress?: (progress: DatabaseExportProgress) => void
  ): Promise<DatabaseExportResult> {
    try {
      if (!Array.isArray(selectedPaths) || selectedPaths.length === 0) {
        return { success: false, error: '未选择任何数据库' }
      }
      if (!getDbStoragePath()) {
        return { success: false, error: '未找到 db_storage 目录，请先配置微信数据目录' }
      }
      const key = String(this.configService.get('decryptKey') || '').trim()
      if (!key) {
        return { success: false, error: '缺少解密密钥，请先在设置中完成数据库连接配置' }
      }

      const subDir = join(outputDir, `数据库导出_${formatTimestamp()}`)
      mkdirSync(subDir, { recursive: true })

      const total = selectedPaths.length
      let successCount = 0
      let failCount = 0
      const tableErrors: DatabaseTableError[] = []
      const usedNames = new Set<string>()

      for (let i = 0; i < total; i++) {
        const srcPath = selectedPaths[i]
        const dbName = basename(srcPath)
        onProgress?.({ current: i, total, currentSession: dbName, detail: '', phase: 'exporting' })

        // 重名（如多个 message_*.db 同名场景）用父目录名前缀避免覆盖
        let outName = dbName
        if (usedNames.has(outName.toLowerCase())) {
          outName = `${basename(dirname(srcPath))}_${dbName}`
        }
        usedNames.add(outName.toLowerCase())
        const outPath = join(subDir, outName)

        try {
          const errs = await this.exportOneDatabase(srcPath, outPath, dbName, (table) => {
            onProgress?.({ current: i, total, currentSession: dbName, detail: table, phase: 'exporting' })
          })
          tableErrors.push(...errs)
          successCount++
          onProgress?.({ current: i + 1, total, currentSession: dbName, detail: '已完成当前数据库', phase: 'exporting' })
        } catch (e) {
          failCount++
          tableErrors.push({
            db: dbName,
            table: '(整库)',
            error: e instanceof Error ? e.message : String(e)
          })
          onProgress?.({
            current: i + 1,
            total,
            currentSession: dbName,
            detail: `当前数据库导出失败: ${e instanceof Error ? e.message : String(e)}`,
            phase: 'exporting'
          })
        }
      }

      onProgress?.({ current: total, total, currentSession: '', detail: '', phase: 'complete' })

      return {
        success: successCount > 0,
        successCount,
        failCount,
        outputDir: subDir,
        tableErrors: tableErrors.length ? tableErrors : undefined,
        error: successCount === 0 ? tableErrors[0]?.error || '导出失败' : undefined
      }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  private async exportOneDatabase(
    srcPath: string,
    outPath: string,
    dbName: string,
    onTable?: (table: string) => void
  ): Promise<DatabaseTableError[]> {
    const objects = await dbAdapter.all<{ type: string; name: string; sql: string }>(
      QUERY_KIND,
      srcPath,
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL"
    )

    if (existsSync(outPath)) {
      try {
        rmSync(outPath)
      } catch {
        /* ignore，下面 new Database 会再报错 */
      }
    }

    const errs: DatabaseTableError[] = []
    const out = new Database(outPath)
    try {
      out.pragma('journal_mode = OFF')
      out.pragma('synchronous = OFF')

      const tables = objects.filter((o) => o.type === 'table')
      const others = objects.filter((o) => o.type !== 'table') // index / trigger / view

      // 先建表并灌数据
      for (const t of tables) {
        onTable?.(t.name)
        try {
          out.exec(t.sql)
          await this.copyTableData(srcPath, t.name, out)
        } catch (e) {
          errs.push({ db: dbName, table: t.name, error: e instanceof Error ? e.message : String(e) })
        }
      }

      // 再建 index / trigger / view（依赖表已存在）
      for (const o of others) {
        try {
          out.exec(o.sql)
        } catch (e) {
          errs.push({ db: dbName, table: o.name, error: e instanceof Error ? e.message : String(e) })
        }
      }
    } finally {
      out.close()
    }
    return errs
  }

  /** 用 quote() 逐列读出 SQL 字面量，拼 INSERT 灌入明文库，忠实保留 BLOB / int64 / text。 */
  private async copyTableData(srcPath: string, table: string, out: Database.Database): Promise<void> {
    const cols = await dbAdapter.all<{ name: string }>(
      QUERY_KIND,
      srcPath,
      `PRAGMA table_info(${quoteIdent(table)})`
    )
    const colNames = cols.map((c) => c.name)
    if (colNames.length === 0) return

    const quotedCols = colNames.map(quoteIdent).join(', ')
    // 别名 c0/c1... 保证按顺序取值，规避对象键名/顺序不确定
    const selectExpr = colNames.map((c, i) => `quote(${quoteIdent(c)}) AS c${i}`).join(', ')
    const insertHead = `INSERT INTO ${quoteIdent(table)} (${quotedCols}) VALUES `

    let offset = 0
    for (;;) {
      const rows = await dbAdapter.all<Record<string, string>>(
        QUERY_KIND,
        srcPath,
        `SELECT ${selectExpr} FROM ${quoteIdent(table)} LIMIT ${SELECT_BATCH} OFFSET ${offset}`
      )
      if (rows.length === 0) break

      // quote() 永远返回非空字符串字面量（NULL 列返回文本 'NULL'），直接拼接即为合法 SQL
      const tuples = rows.map((row) => {
        const vals = colNames.map((_, i) => row[`c${i}`])
        return `(${vals.join(',')})`
      })

      out.exec('BEGIN')
      try {
        for (let i = 0; i < tuples.length; i += INSERT_CHUNK) {
          const chunk = tuples.slice(i, i + INSERT_CHUNK)
          out.exec(insertHead + chunk.join(',') + ';')
        }
        out.exec('COMMIT')
      } catch (e) {
        try {
          out.exec('ROLLBACK')
        } catch {
          /* ignore */
        }
        throw e
      }

      if (rows.length < SELECT_BATCH) break
      offset += SELECT_BATCH
    }
  }
}

export const databaseExportService = new DatabaseExportService()
