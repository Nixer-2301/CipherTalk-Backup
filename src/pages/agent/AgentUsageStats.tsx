/**
 * 消息用量/费用统计：token 明细格式化、按本地模型价格表估算费用、消息底部的操作条。
 * 从 AgentPage.tsx 拆出。
 */
import type { ReactNode } from 'react'
import { Check, Copy, Volume } from '@gravity-ui/icons'
import type { UIMessage } from 'ai'
import { MessageAction, MessageActions } from '@/components/ai-elements/message'
import type { AIModelInfo } from '@/types/ai'
import { finiteNumber, parseAgentMessageMetadata, type AgentMessageMetadata } from './agentConversationHelpers'

export function formatTokenCount(value: number): string {
  return Math.round(value).toLocaleString('zh-CN')
}

export function formatEstimatedCost(value: number): string {
  if (value <= 0) return '约 $0.0000'
  return `约 $${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`
}

export function formatDurationMs(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`
  if (value < 60_000) return `${(Math.round(value / 100) / 10).toFixed(1)}s`
  const minutes = Math.floor(value / 60_000)
  const seconds = Math.round((value % 60_000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`
}

export function formatFinishReason(value: string): string {
  switch (value) {
    case 'stop':
      return '正常结束'
    case 'tool-calls':
      return '工具调用'
    case 'length':
      return '长度限制'
    case 'content-filter':
      return '内容过滤'
    case 'error':
      return '出错'
    case 'other':
      return '其他'
    default:
      return value
  }
}

function estimateUsageCost(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): number | null {
  const usage = metadata.usage
  if (!usage) return null
  const modelInfo = metadata.modelProvider && metadata.modelId
    ? modelInfoByKey.get(`${metadata.modelProvider}::${metadata.modelId}`) || modelInfoByKey.get(metadata.modelId)
    : metadata.modelId
      ? modelInfoByKey.get(metadata.modelId)
      : undefined
  const cost = modelInfo?.cost
  if (!cost) return null

  const inputTokens = finiteNumber(usage.inputTokens)
  const cacheReadTokens = finiteNumber(usage.inputTokenDetails?.cacheReadTokens)
  const cacheWriteTokens = finiteNumber(usage.inputTokenDetails?.cacheWriteTokens)
  const noCacheTokens = finiteNumber(usage.inputTokenDetails?.noCacheTokens)
    ?? (inputTokens !== undefined
      ? Math.max(0, inputTokens - (cacheReadTokens || 0) - (cacheWriteTokens || 0))
      : undefined)
  const outputTokens = finiteNumber(usage.outputTokens)

  let total = 0
  let priced = false
  const add = (tokens: number | undefined, pricePerMillion: number | undefined) => {
    if (tokens === undefined || pricePerMillion === undefined) return
    total += (tokens / 1_000_000) * pricePerMillion
    priced = true
  }

  add(noCacheTokens, cost.input)
  add(cacheReadTokens, cost.cacheRead ?? cost.input)
  add(cacheWriteTokens, cost.cacheWrite ?? cost.input)
  add(outputTokens, cost.output)
  return priced ? total : null
}

function estimateCacheSavings(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): number | null {
  const usage = metadata.usage
  if (!usage) return null
  const modelInfo = metadata.modelProvider && metadata.modelId
    ? modelInfoByKey.get(`${metadata.modelProvider}::${metadata.modelId}`) || modelInfoByKey.get(metadata.modelId)
    : metadata.modelId
      ? modelInfoByKey.get(metadata.modelId)
      : undefined
  const cost = modelInfo?.cost
  const inputPrice = finiteNumber(cost?.input)
  const cacheReadPrice = finiteNumber(cost?.cacheRead)
  const cacheReadTokens = finiteNumber(usage.inputTokenDetails?.cacheReadTokens)
  if (inputPrice === undefined || cacheReadPrice === undefined || cacheReadTokens === undefined || cacheReadTokens <= 0) return null
  return Math.max(0, (cacheReadTokens / 1_000_000) * (inputPrice - cacheReadPrice))
}

function formatCacheProvider(value: string | undefined): string {
  switch (value) {
    case 'openai-responses':
      return 'OpenAI Responses'
    case 'anthropic':
      return 'Anthropic'
    case 'google':
      return 'Google'
    case 'openai-compatible':
      return 'OpenAI-compatible'
    case 'none':
      return '未识别'
    default:
      return value || '未知'
  }
}

function truncateCacheKey(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.length > 56 ? `${value.slice(0, 28)}…${value.slice(-16)}` : value
}

function cacheHitRateNote(metadata: AgentMessageMetadata, cacheReadTokens: number | undefined): string | undefined {
  const providerCache = metadata.ciphertalk?.providerCache
  if (providerCache?.promptCacheEnabled === false) {
    return providerCache.reason || '当前 provider 未启用可控 prompt cache'
  }
  if (cacheReadTokens === undefined) {
    return providerCache?.promptCacheEnabled
      ? '已发送缓存参数，但服务商未返回缓存读 token'
      : '服务商未返回缓存读 token'
  }
  if (cacheReadTokens <= 0) {
    return providerCache?.promptCacheEnabled
      ? '已发送缓存参数，本次未命中 provider 侧缓存'
      : '服务商返回 0 个缓存读 token'
  }
  return providerCache?.promptCacheEnabled ? 'provider 侧缓存已命中' : undefined
}

type UsageDetailRow = {
  id: string
  label: string
  value: ReactNode
  note?: string
}

export function buildUsageDetailRows(metadata: AgentMessageMetadata, modelInfoByKey: Map<string, AIModelInfo>): UsageDetailRow[] {
  const rows: UsageDetailRow[] = []
  const usage = metadata.usage
  const add = (id: string, label: string, value: unknown, note?: string) => {
    if (value === undefined || value === null || value === '') return
    rows.push({ id, label, value: String(value), note })
  }
  const addTokens = (id: string, label: string, value: unknown, note?: string) => {
    const n = finiteNumber(value)
    if (n !== undefined) rows.push({ id, label, value: formatTokenCount(n), note })
  }

  add('model', '模型', [metadata.modelProvider, metadata.modelId].filter(Boolean).join(' / '))
  if (metadata.finishReason) add('finishReason', '结束原因', formatFinishReason(metadata.finishReason), metadata.rawFinishReason)

  const providerCache = metadata.ciphertalk?.providerCache
  if (providerCache) {
    add(
      'providerCacheStatus',
      'Prompt cache',
      providerCache.promptCacheEnabled ? '已启用' : '未启用',
      [
        formatCacheProvider(providerCache.promptCacheProvider),
        providerCache.reason,
      ].filter(Boolean).join('；'),
    )
    add('providerCacheKey', '缓存 key', truncateCacheKey(providerCache.promptCacheKey), '用于 provider 侧 prompt cache 分组')
    add('providerCacheField', '请求字段', providerCache.requestBodyPromptCacheField, '实际写入 provider 请求体的缓存字段')
    add('providerCacheRetention', '缓存保留', providerCache.promptCacheRetention, 'OpenAI 5.1 系列支持 24h；未显示则使用 provider 默认')
  }

  addTokens('inputTokens', '输入 tokens', usage?.inputTokens)
  const cacheReadTokens = finiteNumber(usage?.inputTokenDetails?.cacheReadTokens)
  const cacheHitRate = finiteNumber(usage?.cacheHitRate)
    ?? (() => {
      const inputTokens = finiteNumber(usage?.inputTokens)
      return inputTokens && cacheReadTokens !== undefined ? cacheReadTokens / inputTokens : undefined
    })()
  if (cacheHitRate !== undefined) add('cacheHitRate', '缓存命中率', formatPercent(cacheHitRate), cacheHitRateNote(metadata, cacheReadTokens))
  else if (providerCache) add('cacheHitRate', '缓存命中率', '未返回', cacheHitRateNote(metadata, cacheReadTokens))
  addTokens('noCacheTokens', '普通输入 tokens', usage?.inputTokenDetails?.noCacheTokens)
  addTokens('cacheReadTokens', '缓存读 tokens', cacheReadTokens)
  addTokens('cacheWriteTokens', '缓存写入 tokens', usage?.inputTokenDetails?.cacheWriteTokens)
  addTokens('outputTokens', '输出 tokens', usage?.outputTokens)
  addTokens('textTokens', '文本输出 tokens', usage?.outputTokenDetails?.textTokens)
  addTokens('reasoningTokens', '推理 tokens', usage?.outputTokenDetails?.reasoningTokens)
  addTokens('totalTokens', '总 tokens', usage?.totalTokens, '服务商口径，可能包含推理或额外开销')

  const estimatedCost = estimateUsageCost(metadata, modelInfoByKey)
  if (estimatedCost !== null) add('estimatedCost', '估算费用', formatEstimatedCost(estimatedCost), '按本地模型价格表估算')
  const cacheSavings = estimateCacheSavings(metadata, modelInfoByKey)
  if (cacheSavings !== null && cacheSavings > 0) add('cacheSavings', '缓存节省', formatEstimatedCost(cacheSavings), '按普通输入价与缓存读价差估算')

  const trace = metadata.ciphertalk?.trace
  if (trace) {
    add('traceTotalElapsed', '总耗时', trace.totalElapsedMs !== undefined ? formatDurationMs(trace.totalElapsedMs) : undefined, 'Agent 本轮端到端耗时')
    add('traceFirstOutput', '首个输出', trace.firstOutputMs !== undefined ? formatDurationMs(trace.firstOutputMs) : undefined, '从开始到首次文本/推理/工具输入')
    add('traceSteps', '模型步数', trace.stepCount || trace.steps.length)
    add('traceTools', '工具调用数', trace.toolCount || trace.tools.length)
    const slowestTool = trace.tools.reduce((best, item) => (item.elapsedMs > (best?.elapsedMs ?? -1) ? item : best), undefined as (typeof trace.tools)[number] | undefined)
    if (slowestTool) add('traceSlowestTool', '最慢工具', `${slowestTool.toolName} · ${formatDurationMs(slowestTool.elapsedMs)}`, slowestTool.error)
    if (trace.steps.length > 0) {
      rows.push({
        id: 'traceStepDetails',
        label: '模型步骤耗时',
        value: (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 text-[11px]">
            {trace.steps.map((step) => [
              `#${step.stepNumber + 1}`,
              step.provider && step.modelId ? `${step.provider}/${step.modelId}` : undefined,
              step.elapsedMs !== undefined ? `step=${formatDurationMs(step.elapsedMs)}` : undefined,
              step.responseMs !== undefined ? `response=${formatDurationMs(step.responseMs)}` : undefined,
              step.timeToFirstOutputMs !== undefined ? `ttfo=${formatDurationMs(step.timeToFirstOutputMs)}` : undefined,
              step.usage?.inputTokens !== undefined ? `input=${formatTokenCount(step.usage.inputTokens)}` : undefined,
              step.usage?.inputTokenDetails?.cacheReadTokens !== undefined ? `cacheRead=${formatTokenCount(step.usage.inputTokenDetails.cacheReadTokens)}` : undefined,
              step.finishReason ? `finish=${step.finishReason}` : undefined,
              step.usage?.raw ? `raw=${JSON.stringify(step.usage.raw)}` : undefined,
            ].filter(Boolean).join(' · ')).join('\n')}
          </pre>
        ),
        note: 'AI SDK 7 performance',
      })
    }
    if (trace.tools.length > 0) {
      rows.push({
        id: 'traceToolDetails',
        label: '工具耗时',
        value: (
          <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 text-[11px]">
            {trace.tools.map((item) => [
              item.toolName,
              formatDurationMs(item.elapsedMs),
              item.error ? `error=${item.error}` : undefined,
            ].filter(Boolean).join(' · ')).join('\n')}
          </pre>
        ),
        note: 'AI SDK 7 tool execution',
      })
    }
  }

  if (usage?.raw) {
    rows.push({
      id: 'rawUsage',
      label: '服务商原始 usage',
      value: (
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/30 p-2 text-[11px]">
          {JSON.stringify(usage.raw, null, 2)}
        </pre>
      ),
    })
  }

  return rows
}

export function messageTextOf(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n\n')
    .trim()
}

export function MessageUsageStats({
  defaultVisible,
  metadata,
  messageText,
  copied,
  speaking,
  onCopy,
  onSpeak,
}: {
  defaultVisible: boolean
  metadata: unknown
  messageText: string
  copied: boolean
  speaking: boolean
  onCopy: () => void
  onSpeak: () => void
}) {
  const parsed = parseAgentMessageMetadata(metadata)
  if (!parsed && !messageText) return null

  return (
    <div className={`mt-2 text-[11px] leading-5 text-muted-foreground transition-opacity ${defaultVisible ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'}`}>
      <div className="flex items-center">
        <MessageActions className="shrink-0">
          <MessageAction
            disabled={!messageText}
            label="复制"
            onClick={onCopy}
            tooltip={copied ? '已复制' : '复制'}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </MessageAction>
          <MessageAction
            disabled={!messageText}
            label={speaking ? '停止播放' : '播放'}
            onClick={onSpeak}
            tooltip={speaking ? '停止播放' : '播放'}
          >
            <Volume className={`size-3.5 ${speaking ? 'text-accent-foreground' : ''}`} />
          </MessageAction>
        </MessageActions>
      </div>
    </div>
  )
}
