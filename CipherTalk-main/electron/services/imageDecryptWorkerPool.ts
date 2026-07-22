/**
 * 图片 dat 解密 worker 线程池。
 *
 * 把读盘 + AES + XOR 从调用方线程挪到 worker_threads 真并行（导出场景 12 路并发时不再串行排队）。
 * 懒启动、按需扩到 POOL_SIZE，全部空闲 60s 后自动回收线程。
 * 池不可用（worker 文件缺失/启动失败）时 decrypt 返回 null，调用方原地回退主线程解密。
 */
import { Worker } from 'worker_threads'
import { join } from 'path'
import { existsSync } from 'fs'
import os from 'os'
import type { DatDecryptOutcome } from './datDecryptCore'

// ponytail: 上限 4 线程，解密是短任务，够喂饱导出的 12 路并发；不够快再调
const POOL_SIZE = Math.max(2, Math.min(4, os.cpus().length - 2))
const IDLE_SHUTDOWN_MS = 60_000

type Pending = {
  resolve: (v: DatDecryptOutcome) => void
  reject: (e: Error) => void
}

class ImageDecryptWorkerPool {
  private workers: Worker[] = []
  private idleWorkers: Worker[] = []
  private waitQueue: Array<(w: Worker) => void> = []
  private pendingByWorker = new Map<Worker, Pending>()
  private nextId = 1
  private unavailable = false
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * 池不可用时返回 null（调用方回退主线程）；worker 内解密失败时 reject。
   */
  decrypt(datPath: string, xorKey: number, aesKeyText: string, aesKey: Buffer | null): Promise<DatDecryptOutcome> | null {
    if (this.unavailable) return null
    if (this.workers.length === 0 && !existsSync(this.workerPath())) {
      this.unavailable = true
      console.warn('[ImageDecryptPool] worker 文件不存在，回退主线程解密:', this.workerPath())
      return null
    }
    return this.run(datPath, xorKey, aesKeyText, aesKey)
  }

  private workerPath(): string {
    return join(__dirname, 'imageDecryptWorker.js')
  }

  private async run(datPath: string, xorKey: number, aesKeyText: string, aesKey: Buffer | null): Promise<DatDecryptOutcome> {
    const worker = await this.acquire()
    return new Promise<DatDecryptOutcome>((resolve, reject) => {
      this.pendingByWorker.set(worker, { resolve, reject })
      worker.postMessage({
        id: this.nextId++,
        datPath,
        xorKey,
        aesKeyText,
        aesKeyB64: aesKey ? aesKey.toString('base64') : null
      })
    })
  }

  private acquire(): Promise<Worker> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    const idle = this.idleWorkers.pop()
    if (idle) return Promise.resolve(idle)
    if (this.workers.length < POOL_SIZE) {
      const spawned = this.spawn()
      if (spawned) return Promise.resolve(spawned)
      if (this.workers.length === 0) {
        return Promise.reject(new Error('worker 池启动失败'))
      }
    }
    return new Promise((res) => this.waitQueue.push(res))
  }

  private release(worker: Worker): void {
    const waiter = this.waitQueue.shift()
    if (waiter) {
      waiter(worker)
      return
    }
    this.idleWorkers.push(worker)
    if (this.idleWorkers.length === this.workers.length) {
      this.scheduleIdleShutdown()
    }
  }

  private spawn(): Worker | null {
    try {
      const worker = new Worker(this.workerPath())
      worker.unref()
      worker.on('message', (msg: any) => {
        const pending = this.pendingByWorker.get(worker)
        if (!pending) return
        this.pendingByWorker.delete(worker)
        if (msg?.ok) {
          pending.resolve({
            // 结构化克隆后是 Uint8Array，包回 Buffer
            data: Buffer.isBuffer(msg.data) ? msg.data : Buffer.from(msg.data),
            source: msg.source,
            fallbackReason: msg.fallbackReason
          })
        } else {
          pending.reject(new Error(msg?.error || 'worker 解密失败'))
        }
        this.release(worker)
      })
      const onDeath = (err?: Error) => {
        const pending = this.pendingByWorker.get(worker)
        if (pending) {
          this.pendingByWorker.delete(worker)
          pending.reject(err || new Error('worker 线程退出'))
        }
        this.removeWorker(worker)
      }
      worker.on('error', (err: Error) => onDeath(err))
      worker.on('exit', (code) => {
        if (code !== 0) onDeath(new Error(`worker 异常退出 code=${code}`))
        else this.removeWorker(worker)
      })
      this.workers.push(worker)
      return worker
    } catch (e: any) {
      console.warn('[ImageDecryptPool] worker 启动失败，回退主线程解密:', e?.message || String(e))
      if (this.workers.length === 0) this.unavailable = true
      return null
    }
  }

  private removeWorker(worker: Worker): void {
    this.workers = this.workers.filter((w) => w !== worker)
    this.idleWorkers = this.idleWorkers.filter((w) => w !== worker)
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      for (const w of this.workers) {
        void w.terminate()
      }
      this.workers = []
      this.idleWorkers = []
    }, IDLE_SHUTDOWN_MS)
    this.idleTimer.unref?.()
  }
}

export const imageDecryptWorkerPool = new ImageDecryptWorkerPool()
