/**
 * 单条 Agent 消息的渲染——从 AgentPage.tsx 的 messages.map() 里拆出来，用 React.memo 包裹。
 *
 * 为什么需要这个文件：useChat 流式更新时，@ai-sdk/react 只替换"当前那条"消息的对象引用，
 * 其它历史消息保持原引用不变（见 ReactChatState.replaceMessage 的实现）。但原来的写法是在
 * messages.map() 里直接内联构建每条消息的 JSX，没有任何 memo 边界，导致哪怕只有最后一条消息在
 * 流式更新，整个对话里所有历史消息也会跟着每 ~50ms 重新构建一遍——对话越长、代码块越多，越卡。
 *
 * 这里包一层 memo，配合自定义比较函数：只有当这条消息"就是正在流式输出的最后一条"时，才关心
 * toolElapsedByKey / subAgentProgress 这类高频变化的字段；历史消息自己的工具耗时和子助手进度早
 * 就定型了，这两个字段再怎么变也不需要重渲染。
 */
import { memo } from 'react'
import { Button as HeroButton } from '@heroui/react'
import { Magnifier, Persons, Play, Terminal, Wrench } from '@gravity-ui/icons'
import type { ChatStatus, UIMessage } from 'ai'
import {
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought'
import {
  Message,
  MessageAttachment,
  MessageAttachments,
  MessageContent,
  MessageResponse,
  MessageStreamingIndicator,
} from '@/components/ai-elements/message'
import type { AgentProgressEvent } from '@/features/aiagent/transport/ipcChatTransport'
import { MentionTargetChips, WorkspaceFileReferenceChips, getUserMessageDisplay } from './AgentMentions'
import {
  MessageSources,
  MessageProviderSources,
  buildRenderSegments,
  collectRetrievalBadges,
  collectToolBadges,
  extractSources,
  extractProviderSources,
  formatElapsed,
  formatToolStepLabel,
  getDelegateTasks,
  isAgentChainPart,
  isCommandTool,
  planRequiresDelegateAnalysis,
  pushBadge,
  renderChainLabel,
  stripPlanControlMarkers,
  toolPartProgressKey,
  type AgentChainPart,
  type AgentMessagePart,
} from './agentMessageHelpers'
import { readSubAgentProgressFromMessage, type AgentMessageMetadata } from './agentConversationHelpers'
import { AgentCanvasReference } from './canvas/AgentCanvasReference'
import type { AgentCanvasRefData } from './canvas/agentCanvasTypes'
import { messageTextOf, MessageUsageStats } from './AgentUsageStats'
import { SubAgentProgressPanel } from './AgentSubAgentProgress'
import { CompactionMarker, MessageChainOfThought, PlanCard, ToolIODetails, UserMessageActions, type CompactionPartData } from './AgentMessageBlocks'

export type AgentImagePreviewPayload = {
  src: string
  originRect: { left: number; top: number; width: number; height: number }
}

export type AgentMessageItemProps = {
  message: UIMessage
  messageIndex: number
  isLastMessage: boolean
  isLatestAssistant: boolean
  busy: boolean
  status: ChatStatus
  runIsPlan: boolean
  subAgentProgress: AgentProgressEvent[]
  toolElapsedByKey: Record<string, number>
  selectedModelSupportsTools: boolean
  copied: boolean
  speaking: boolean
  sessionNameOf: (sessionId: string) => string
  onCopyAssistant: (messageId: string, text: string) => void
  onCopyUser: (messageId: string, text: string) => void
  onSpeak: (messageId: string, text: string) => void
  onEdit: (messageIndex: number, text: string) => void
  onExecutePlan: () => void
  onPreviewGeneratedImage: (payload: AgentImagePreviewPayload) => void
  onOpenCanvas?: (data: AgentCanvasRefData) => void
}

function AgentMessageItemImpl({
  message,
  messageIndex,
  isLastMessage,
  isLatestAssistant,
  busy,
  status,
  runIsPlan,
  subAgentProgress,
  toolElapsedByKey,
  selectedModelSupportsTools,
  copied,
  speaking,
  sessionNameOf,
  onCopyAssistant,
  onCopyUser,
  onSpeak,
  onEdit,
  onExecutePlan,
  onPreviewGeneratedImage,
  onOpenCanvas,
}: AgentMessageItemProps) {
  const lastPart = message.parts[message.parts.length - 1]
  const isReasoningStreaming = isLastMessage && status === 'streaming' && lastPart?.type === 'reasoning'
  const chainActive = isLastMessage && busy
  const assistantText = message.role === 'assistant' ? messageTextOf(message) : ''
  const userMessageText = message.role === 'user' ? messageTextOf(message) : ''
  const assistantTextStreaming = message.role === 'assistant' && isLastMessage && status === 'streaming'
  const persistedTrace = (message.metadata as AgentMessageMetadata | undefined)?.ciphertalk?.trace
  const persistedProcessingElapsedMs = persistedTrace?.totalElapsedMs
  // 计划模式生成的消息：正文(执行计划)走 PlanCard 折叠卡片，不再走普通 Markdown 渲染。
  // 完成后看 metadata.planMode；流式期间 metadata 还没回来，靠在途标记 runIsPlan 判定。
  const isPlanMessage = message.role === 'assistant' && (
    (message.metadata as AgentMessageMetadata | undefined)?.planMode === true
    || (isLastMessage && busy && runIsPlan)
  )
  const assistantDisplayText = isPlanMessage ? stripPlanControlMarkers(assistantText) : assistantText
  const providerSources = message.role === 'assistant' ? extractProviderSources(message.parts) : []
  const chatSources = message.role === 'assistant' ? extractSources(message.parts) : []
  const planNeedsDelegateAnalysis = isPlanMessage && planRequiresDelegateAnalysis(assistantText)
  const userDisplay = message.role === 'user' ? getUserMessageDisplay(message.parts) : null
  const persistedSubAgentEvents = message.role === 'assistant' ? readSubAgentProgressFromMessage(message) : []
  const subAgentEventsForMessage = message.role === 'assistant'
    ? (isLastMessage && subAgentProgress.length > 0 ? subAgentProgress : persistedSubAgentEvents)
    : []
  const orderedSegments = buildRenderSegments(message.parts)
  const chainSegmentCount = orderedSegments.reduce((count, segment) => count + (segment.kind === 'chain' ? 1 : 0), 0)
  const lastChainSegmentIndex = orderedSegments.reduce(
    (lastIndex, segment, index) => segment.kind === 'chain' ? index : lastIndex,
    -1,
  )
  const persistedSingleChainElapsedMs = chainSegmentCount === 1 ? persistedProcessingElapsedMs : undefined
  // 一条消息里同一画布可能有多次 data-canvas（多轮编辑），只保留最后一条引用行
  const lastCanvasRefIndexById = new Map<string, number>()
  message.parts.forEach((part, index) => {
    if (part.type === 'data-canvas') {
      const canvasId = (part as { data?: AgentCanvasRefData }).data?.canvasId
      if (canvasId) lastCanvasRefIndexById.set(canvasId, index)
    }
  })
  const userFileParts = message.role === 'user'
    ? message.parts
      .map((part, index) => ({ part, index }))
      .filter((item): item is { part: Extract<UIMessage['parts'][number], { type: 'file' }>; index: number } => item.part.type === 'file')
    : []
  const hasRenderableUserText = message.role === 'user'
    && message.parts.some((part, index) => {
      if (part.type !== 'text') return false
      const displayText = userDisplay?.textByPartIndex.get(index) ?? part.text
      return Boolean(displayText.trim())
    })
  const shouldRenderMessageContent = message.role !== 'user' || hasRenderableUserText
  // generate_image / send_sticker / send_random_image / send_media_from_history / inspect_media_image 的产出图：正文区直接展示
  const renderGeneratedImageTool = (part: AgentMessagePart, index: number) => {
    if (!isAgentChainPart(part)) return null
    const isSticker = part.type === 'tool-send_sticker'
    const isRandomImage = part.type === 'tool-send_random_image'
    const isHistoryMedia = part.type === 'tool-send_media_from_history'
    const isInspectMedia = part.type === 'tool-inspect_media_image'
    const isGenerated = part.type === 'tool-generate_image'
    if ((!isSticker && !isRandomImage && !isHistoryMedia && !isInspectMedia && !isGenerated) || part.state !== 'output-available') return null
    const output = part.output as { filePath?: unknown; from?: unknown; sender?: unknown; time?: unknown; mediaKind?: unknown } | undefined
    const filePath = String(output?.filePath || '')
    if (!filePath) return null
    const imageSrc = `local-image://${encodeURIComponent(filePath)}`
    const caption = isRandomImage || isHistoryMedia || isInspectMedia
      ? [output?.sender, output?.from, output?.time].map((v) => String(v || '')).filter(Boolean).join(' · ')
      : ''
    return (
      <div className="mt-1 w-fit" key={`genimg-${index}`}>
        <button
          className="block w-fit cursor-pointer border-0 bg-transparent p-0 text-left"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            onPreviewGeneratedImage({
              src: imageSrc,
              originRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
            })
          }}
          title="点击预览"
          type="button"
        >
          <img
            alt={isSticker || output?.mediaKind === 'emoji' ? '表情包' : isRandomImage || isHistoryMedia || isInspectMedia ? '历史图片' : 'AI 生成的图片'}
            className={isSticker || output?.mediaKind === 'emoji'
              ? 'max-h-40 max-w-40 rounded-(--agent-radius,12px)'
              : 'max-h-90 max-w-full rounded-(--agent-radius,12px) border border-border/60 shadow-xs'}
            src={imageSrc}
          />
        </button>
        {caption && (
          <div className="mt-1 text-muted-foreground text-xs">{caption}</div>
        )}
      </div>
    )
  }
  const renderChainSegment = (segment: Array<{ part: AgentChainPart; index: number }>, segmentActive: boolean) => (
    <MessageChainOfThought
      active={segmentActive}
      key={`chain-${segment[0]?.index ?? 0}`}
      persistedElapsedMs={persistedSingleChainElapsedMs}
    >
      {segment.map(({ part, index }) => {
        if (part.type === 'reasoning') {
          const reasoningActive = isReasoningStreaming && index === message.parts.length - 1
          return (
            <MessageResponse
              className="text-foreground text-sm"
              isStreaming={reasoningActive}
              key={`chain-${index}`}
              showStreamingIndicator={false}
            >
              {part.text}
            </MessageResponse>
          )
        }
        const toolName = part.type.replace(/^tool-/, '')
        if (part.state === 'approval-requested' || part.state === 'approval-responded' || part.state === 'output-denied') {
          return null
        }
        const done = part.state === 'output-available' || part.state === 'output-error'
        const toolActive = segmentActive && !done
        const toolLabel = formatToolStepLabel(toolName, part.state, part.input, part.output)
        const elapsedMs = toolElapsedByKey[toolPartProgressKey(part, toolName)]
        const label = [
          toolLabel,
          done && elapsedMs != null ? formatElapsed(elapsedMs) : '',
        ].filter(Boolean).join(' · ')
        const badges = collectToolBadges(part.input)
        const delegateTasks = toolName === 'delegate_analysis' ? getDelegateTasks(part) : undefined
        if (part.state === 'output-available') {
          for (const badge of collectRetrievalBadges(toolName, part.output)) pushBadge(badges, badge)
          collectToolBadges(part.output, badges)
        }
        return (
          <ChainOfThoughtStep
            icon={toolName.includes('search') ? Magnifier : isCommandTool(toolName) ? Terminal : Wrench}
            key={`chain-${index}`}
            label={renderChainLabel(label, toolActive)}
            status={toolActive ? 'active' : 'complete'}
          >
            {badges.length > 0 && (
              <ChainOfThoughtSearchResults>
                {badges.map((badge) => (
                  <ChainOfThoughtSearchResult key={badge}>
                    {badge}
                  </ChainOfThoughtSearchResult>
                ))}
              </ChainOfThoughtSearchResults>
            )}
            {part.state === 'output-error' && part.errorText && (
              <p className="text-destructive text-xs">{part.errorText}</p>
            )}
            {toolName === 'delegate_analysis' && subAgentEventsForMessage.length > 0 && (
              <SubAgentProgressPanel events={subAgentEventsForMessage} tasks={delegateTasks} />
            )}
            {toolName !== 'delegate_analysis' && (
              <ToolIODetails input={part.input} />
            )}
          </ChainOfThoughtStep>
        )
      })}
    </MessageChainOfThought>
  )

  return (
    <Message from={message.role}>
      {userDisplay && <MentionTargetChips align="end" targets={userDisplay.mentions} />}
      {userDisplay && <WorkspaceFileReferenceChips align="end" refs={userDisplay.workspaceFiles} />}
      {userFileParts.length > 0 && (
        <MessageAttachments className="justify-end">
          {userFileParts.map(({ part, index }) => (
            <MessageAttachment data={part} key={`user-file-${index}`} />
          ))}
        </MessageAttachments>
      )}
      {shouldRenderMessageContent && (
        <MessageContent>
          {isPlanMessage && assistantDisplayText && (
            <PlanCard streaming={assistantTextStreaming} text={assistantDisplayText} />
          )}
          {orderedSegments.map((segment, segmentIndex) => {
            const isLastSegment = segmentIndex === orderedSegments.length - 1
            if (segment.kind === 'chain') {
              // 每个过程区块独立计时；新过程出现后，前一个区块立即冻结为“已处理”。
              const segmentActive = chainActive && segmentIndex === lastChainSegmentIndex
              return (
                <div className="space-y-2" key={`chain-${segment.items[0]?.index ?? 0}`}>
                  {renderChainSegment(segment.items, segmentActive)}
                  {segment.items.map(({ part, index }) => renderGeneratedImageTool(part, index))}
                </div>
              )
            }
            const { part, index } = segment
            if (part.type === 'text') {
              // 计划消息的正文已经在 PlanCard 里展示，这里不再重复渲染。
              if (isPlanMessage) return null
              const displayText = userDisplay?.textByPartIndex.get(index) ?? part.text
              if (!displayText) return null
              return (
                <MessageResponse
                  isStreaming={assistantTextStreaming && isLastSegment}
                  key={`text-${index}`}
                  showStreamingIndicator={false}
                >
                  {displayText}
                </MessageResponse>
              )
            }
            if (part.type === 'file') {
              if (message.role === 'user') return null
              return (
                <MessageAttachments key={`file-${index}`}>
                  <MessageAttachment data={part} />
                </MessageAttachments>
              )
            }
            if (part.type === 'data-canvas') {
              const data = (part as { data?: AgentCanvasRefData }).data
              if (!data?.canvasId) return null
              if (lastCanvasRefIndexById.get(data.canvasId) !== index) return null
              return (
                <AgentCanvasReference
                  data={data}
                  key={`canvas-${data.canvasId}-${index}`}
                  onOpen={onOpenCanvas}
                />
              )
            }
            if (part.type === 'data-compaction') {
              const partId = (part as { id?: string }).id
              return (
                <CompactionMarker
                  data={((part as { data?: CompactionPartData }).data) || {}}
                  key={`compaction-${partId || index}`}
                />
              )
            }
            return null
          })}
          {assistantTextStreaming && <MessageStreamingIndicator />}
          {message.role === 'assistant' && (
            <>
              <MessageProviderSources items={providerSources} />
              <MessageSources items={chatSources} nameOf={sessionNameOf} />
            </>
          )}
          {message.role === 'assistant' && !(isLastMessage && busy) && (
            <MessageUsageStats
              copied={copied}
              defaultVisible={isLatestAssistant}
              metadata={message.metadata}
              messageText={assistantDisplayText}
              onCopy={() => onCopyAssistant(message.id, assistantDisplayText)}
              onSpeak={() => onSpeak(message.id, assistantDisplayText)}
              speaking={speaking}
            />
          )}
          {isPlanMessage && isLastMessage && !busy && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <HeroButton
                isDisabled={!selectedModelSupportsTools}
                onPress={onExecutePlan}
                size="sm"
                variant="primary"
              >
                <Play className="size-3.5" />
                开始执行
              </HeroButton>
              {planNeedsDelegateAnalysis && (
                <span className="inline-flex items-center gap-1 rounded-(--agent-radius,12px) border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-amber-700 text-xs dark:text-amber-300">
                  <Persons className="size-3.5" />
                  预计会委托子助手
                </span>
              )}
              <span className="text-muted-foreground text-xs">确认计划后点此执行，或直接回复修改计划</span>
            </div>
          )}
        </MessageContent>
      )}
      {message.role === 'user' && (
        <UserMessageActions
          copied={copied}
          messageText={userMessageText}
          onCopy={() => onCopyUser(message.id, userMessageText)}
          onEdit={() => onEdit(messageIndex, userMessageText)}
        />
      )}
    </Message>
  )
}

function propsAreEqual(prev: AgentMessageItemProps, next: AgentMessageItemProps): boolean {
  // AI SDK 7 会高频替换最后一条 assistant 消息；这里宁可让在途/刚结束的最后一条多渲染一次，
  // 也不能因为 memo 比较过紧把 text part 的可见更新挡住。
  if (prev.isLastMessage || next.isLastMessage || prev.busy || next.busy || prev.status === 'streaming' || next.status === 'streaming') {
    return false
  }
  if (prev.message !== next.message) return false
  if (prev.messageIndex !== next.messageIndex) return false
  if (prev.isLastMessage !== next.isLastMessage) return false
  if (prev.isLatestAssistant !== next.isLatestAssistant) return false
  if (prev.busy !== next.busy) return false
  if (prev.status !== next.status) return false
  if (prev.selectedModelSupportsTools !== next.selectedModelSupportsTools) return false
  if (prev.copied !== next.copied) return false
  if (prev.speaking !== next.speaking) return false
  if (prev.sessionNameOf !== next.sessionNameOf) return false
  // 这几个只有"这条正好是正在流式输出的最后一条"时才会体现在渲染结果里；
  // 历史消息自己的工具耗时/子助手进度早就定型了，二者再怎么变都不用重渲染历史消息。
  if (next.isLastMessage) {
    if (prev.runIsPlan !== next.runIsPlan) return false
    if (prev.toolElapsedByKey !== next.toolElapsedByKey) return false
    if (prev.subAgentProgress !== next.subAgentProgress) return false
  }
  return true
}

export const AgentMessageItem = memo(AgentMessageItemImpl, propsAreEqual)
AgentMessageItem.displayName = 'AgentMessageItem'
