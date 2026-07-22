import type { Message } from '../../../../types/models'
import MessageContent from '../../../../components/MessageContent'

interface SystemBubbleProps {
  message: Message
}

/**
 * 系统消息气泡（localType === 10000，以及拍一拍 appmsg type=62）
 * 渲染为独立的系统消息行，无头像和常规气泡样式
 */
function SystemBubble({ message }: SystemBubbleProps) {
  const isPatAppMsg = (() => {
    const content = message.rawContent || message.parsedContent || ''
    if (!content) return false
    return /<appmsg[\s\S]*?>[\s\S]*?<type>\s*62\s*<\/type>/i.test(content) || /<patinfo[\s\S]*?>/i.test(content)
  })()

  let systemText = message.parsedContent || '[系统消息]'
  if (isPatAppMsg) {
    try {
      const content = message.rawContent || message.parsedContent || ''
      const xmlContent = content.includes('<msg>') ? content.substring(content.indexOf('<msg>')) : content
      const parser = new DOMParser()
      const doc = parser.parseFromString(xmlContent, 'text/xml')
      systemText = (doc.querySelector('title')?.textContent || systemText || '[拍一拍]').trim()
    } catch {
      // ignore
    }
  }

  return (
    <div className="message-bubble system">
      <div className="bubble-content"><MessageContent content={systemText} /></div>
    </div>
  )
}

export default SystemBubble
