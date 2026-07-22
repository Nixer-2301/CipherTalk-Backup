/**
 * "分享对话"导出卡片：截取最近消息、生成文件名/日期，渲染成可截图的卡片。
 * 从 AgentPage.tsx 拆出。
 */
import type { CSSProperties, Ref } from 'react'
import type { AgentConversationLoaded, AgentMessageMetadata } from './agentConversationHelpers'
import { messageTextOf } from './AgentUsageStats'
import { stripPlanControlMarkers } from './agentMessageHelpers'

const AGENT_SHARE_MAX_MESSAGES = 40
const AGENT_SHARE_MAX_CHARS = 12000

type AgentShareMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export type AgentSharePreviewData = {
  generatedAt: number
  messages: AgentShareMessage[]
  title: string
  truncated: boolean
}

function agentShareMessageText(message: AgentConversationLoaded['messages'][number]): string {
  const rawText = messageTextOf(message)
  if (!rawText) return ''
  const metadata = (message as { metadata?: AgentMessageMetadata }).metadata
  return message.role === 'assistant' && metadata?.planMode
    ? stripPlanControlMarkers(rawText)
    : rawText
}

export function buildAgentSharePreviewData(conversation: AgentConversationLoaded): AgentSharePreviewData {
  const allMessages: AgentShareMessage[] = []
  for (const message of conversation.messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = agentShareMessageText(message)
    if (!text) continue
    allMessages.push({
      id: message.id,
      role: message.role,
      text,
    })
  }

  let charCount = 0
  const selectedReversed: AgentShareMessage[] = []
  let truncated = allMessages.length > AGENT_SHARE_MAX_MESSAGES
  for (let i = allMessages.length - 1; i >= 0; i -= 1) {
    const message = allMessages[i]
    const nextCount = charCount + message.text.length
    if (selectedReversed.length >= AGENT_SHARE_MAX_MESSAGES || (selectedReversed.length > 0 && nextCount > AGENT_SHARE_MAX_CHARS)) {
      truncated = true
      break
    }
    selectedReversed.push(message)
    charCount = nextCount
  }

  return {
    generatedAt: Date.now(),
    messages: selectedReversed.reverse(),
    title: conversation.title || '新对话',
    truncated,
  }
}

export function sanitizeAgentShareFileName(value: string): string {
  const normalized = value
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return normalized || 'Agent'
}

export function formatAgentShareFileDate(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('')
}

function formatAgentShareDisplayDate(value: number): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function AgentShareCard({ data, captureRef }: { data: AgentSharePreviewData; captureRef?: Ref<HTMLDivElement> }) {
  const cardStyle: CSSProperties = {
    background: '#f8fafc',
    borderRadius: 24,
    boxSizing: 'border-box',
    color: '#111827',
    fontFamily: 'Inter, "Microsoft YaHei", "PingFang SC", system-ui, sans-serif',
    letterSpacing: 0,
    overflow: 'hidden',
    width: 720,
  }
  const headerStyle: CSSProperties = {
    background: '#ffffff',
    borderBottom: '1px solid #e5e7eb',
    boxSizing: 'border-box',
    padding: '28px 32px',
  }
  const headerRowStyle: CSSProperties = {
    alignItems: 'center',
    display: 'flex',
    gap: 20,
    justifyContent: 'space-between',
  }
  const titleStyle: CSSProperties = {
    color: '#0f172a',
    fontSize: 28,
    fontWeight: 650,
    lineHeight: 1.22,
    margin: '8px 0 0',
    overflowWrap: 'anywhere',
  }
  const logoStyle: CSSProperties = {
    alignItems: 'center',
    background: '#111827',
    borderRadius: 16,
    color: '#ffffff',
    display: 'flex',
    flexShrink: 0,
    fontSize: 20,
    fontWeight: 700,
    height: 52,
    justifyContent: 'center',
    width: 52,
  }
  const bodyStyle: CSSProperties = {
    boxSizing: 'border-box',
    padding: '28px 32px',
  }
  const footerStyle: CSSProperties = {
    alignItems: 'center',
    background: '#ffffff',
    borderTop: '1px solid #e5e7eb',
    boxSizing: 'border-box',
    color: '#64748b',
    display: 'flex',
    fontSize: 12,
    justifyContent: 'space-between',
    padding: '16px 32px',
  }

  return (
    <div
      ref={captureRef}
      style={cardStyle}
    >
      <div style={headerStyle}>
        <div style={headerRowStyle}>
          <div style={{ minWidth: 0 }}>
            <div style={{ color: '#64748b', fontSize: 13, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
              CipherTalk · Agent 分享
            </div>
            <h2 style={titleStyle}>{data.title}</h2>
          </div>
          <div style={logoStyle}>知</div>
        </div>
        <div style={{ color: '#64748b', fontSize: 13, marginTop: 16 }}>{formatAgentShareDisplayDate(data.generatedAt)}</div>
      </div>

      <div style={bodyStyle}>
        {data.truncated && (
          <div style={{
            background: '#fffbeb',
            border: '1px solid #fde68a',
            borderRadius: 14,
            color: '#92400e',
            fontSize: 13,
            marginBottom: 20,
            padding: '12px 16px',
          }}>
            内容较长，已截取最近部分
          </div>
        )}
        {data.messages.length > 0 ? data.messages.map((message) => {
          const isUser = message.role === 'user'
          const alignStyle: CSSProperties = {
            display: 'flex',
            justifyContent: isUser ? 'flex-end' : 'flex-start',
            marginTop: 20,
          }
          const wrapStyle: CSSProperties = {
            maxWidth: 560,
            textAlign: isUser ? 'right' : 'left',
          }
          const nameStyle: CSSProperties = {
            color: '#64748b',
            fontSize: 12,
            fontWeight: 600,
            marginBottom: 6,
          }
          const bubbleStyle: CSSProperties = {
            background: isUser ? '#111827' : '#ffffff',
            border: isUser ? 'none' : '1px solid #e5e7eb',
            borderRadius: isUser ? '18px 6px 18px 18px' : '6px 18px 18px 18px',
            boxSizing: 'border-box',
            color: isUser ? '#ffffff' : '#111827',
            fontSize: 15,
            lineHeight: '27px',
            overflowWrap: 'anywhere',
            padding: '12px 16px',
            textAlign: 'left',
            whiteSpace: 'pre-wrap',
          }
          return (
            <div key={message.id} style={alignStyle}>
              <div style={wrapStyle}>
                <div style={nameStyle}>{isUser ? '我' : '知微'}</div>
                <div style={bubbleStyle}>{message.text}</div>
              </div>
            </div>
          )
        }) : (
          <div style={{
            background: '#ffffff',
            border: '1px solid #e5e7eb',
            borderRadius: 16,
            color: '#64748b',
            fontSize: 14,
            padding: '32px 16px',
            textAlign: 'center',
          }}>
            这段对话没有可分享的文本内容
          </div>
        )}
      </div>

      <div style={footerStyle}>
        <span>由 CipherTalk 生成</span>
        <span>{data.messages.length} 条消息</span>
      </div>
    </div>
  )
}
