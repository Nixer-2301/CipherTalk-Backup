import { createPortal } from 'react-dom'
import { Dropdown, Label } from '@heroui/react'
import { ArrowDownToLine, ArrowsRotateLeft, CircleInfo, Copy, MagnifierPlus, Pencil, SquareCheck, Volume, VolumeXmark } from '@gravity-ui/icons'
import { useTtsSpeaker } from '@/lib/ttsPlayer'
import type { ChatSession, Message } from '../../../../types/models'
import type { ContextMenuState } from '../../types'

interface ContextMenuPortalProps {
  contextMenu: ContextMenuState | null
  setContextMenu: React.Dispatch<React.SetStateAction<ContextMenuState | null>>
  showTopToast: (text: string, success?: boolean) => void
  setShowEnlargeView: React.Dispatch<React.SetStateAction<{ message: Message; content: string } | null>>
  onEnterSelectMode: (localId: number) => void
  exportVoiceMessage: (message: Message, session: ChatSession) => void | Promise<void>
  setShowMessageInfo: React.Dispatch<React.SetStateAction<Message | null>>
}

export function ContextMenuPortal({
  contextMenu,
  setContextMenu,
  showTopToast,
  setShowEnlargeView,
  onEnterSelectMode,
  exportVoiceMessage,
  setShowMessageInfo
}: ContextMenuPortalProps) {
  const { speakingKey, speak } = useTtsSpeaker()
  if (!contextMenu) return null
  const speakKey = `wxmsg-${contextMenu.message.localId}`
  const isSpeakingThis = speakingKey === speakKey
  const hasTextActions = contextMenu.message.localType !== 34 && contextMenu.message.localType !== 3 && contextMenu.message.localType !== 43
  const hasMultiSelect = contextMenu.message.localType !== 3 && contextMenu.message.localType !== 43
  const itemCount =
    (hasTextActions ? 3 : 0) +
    (hasMultiSelect ? 1 : 0) +
    (contextMenu.message.localType === 34 ? 1 : 0) +
    (contextMenu.handlers?.reTranscribe ? 1 : 0) +
    (contextMenu.handlers?.editStt ? 1 : 0) +
    1
  const padding = 8
  const estimatedMenuWidth = 220
  const estimatedMenuHeight = itemCount * 40 + Math.max(0, itemCount - 1) * 4 + 12
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const spaceRight = viewportWidth - contextMenu.x - padding
  const spaceLeft = contextMenu.x - padding
  const spaceBelow = viewportHeight - contextMenu.y - padding
  const spaceAbove = contextMenu.y - padding
  const openLeft = spaceRight < estimatedMenuWidth && spaceLeft > spaceRight
  const openAbove = spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow
  const maxHeight = openAbove
    ? (estimatedMenuHeight > spaceAbove ? Math.max(120, spaceAbove) : undefined)
    : (estimatedMenuHeight > spaceBelow ? Math.max(120, spaceBelow) : undefined)
  const menuStyle = {
    ...(openLeft
      ? { right: Math.max(padding, viewportWidth - contextMenu.x) }
      : { left: Math.max(padding, Math.min(contextMenu.x, viewportWidth - estimatedMenuWidth - padding)) }),
    ...(openAbove
      ? { bottom: Math.max(padding, viewportHeight - contextMenu.y) }
      : { top: contextMenu.y }),
    maxHeight
  }

  const closeMenu = () => {
    setContextMenu(null)
  }

  return createPortal(
    <div
      className="chat-context-menu-layer"
      onClick={closeMenu}
      onContextMenu={(event) => {
        event.preventDefault()
        closeMenu()
      }}
    >
      <div
        className="chat-context-menu-popover dropdown__popover"
        style={menuStyle}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.stopPropagation()}
      >
        <Dropdown.Menu aria-label="消息操作">
          {contextMenu.message.localType !== 34 && contextMenu.message.localType !== 3 && contextMenu.message.localType !== 43 && (
            <Dropdown.Item
              id="copy"
              textValue="复制"
              onAction={async () => {
                try {
                  await navigator.clipboard.writeText(contextMenu.message.parsedContent || '')
                  closeMenu()
                  showTopToast('已复制', true)
                } catch (e) {
                  console.error('复制失败:', e)
                  closeMenu()
                }
              }}
            >
              <Copy className="size-4 shrink-0 text-muted" />
              <Label>复制</Label>
            </Dropdown.Item>
          )}
          {contextMenu.message.localType !== 34 && contextMenu.message.localType !== 3 && contextMenu.message.localType !== 43 && (
            <Dropdown.Item
              id="enlarge"
              textValue="放大阅读"
              onAction={() => {
                setShowEnlargeView({
                  message: contextMenu.message,
                  content: contextMenu.message.parsedContent || ''
                })
                closeMenu()
              }}
            >
              <MagnifierPlus className="size-4 shrink-0 text-muted" />
              <Label>放大阅读</Label>
            </Dropdown.Item>
          )}
          {contextMenu.message.localType !== 34 && contextMenu.message.localType !== 3 && contextMenu.message.localType !== 43 && (
            <Dropdown.Item
              id="speak"
              textValue={isSpeakingThis ? '停止朗读' : '朗读'}
              onAction={() => {
                closeMenu()
                void speak(speakKey, contextMenu.message.parsedContent || '').then((res) => {
                  if (!res.ok && res.error) showTopToast(res.error, false)
                })
              }}
            >
              {isSpeakingThis ? <VolumeXmark className="size-4 shrink-0 text-muted" /> : <Volume className="size-4 shrink-0 text-muted" />}
              <Label>{isSpeakingThis ? '停止朗读' : '朗读'}</Label>
            </Dropdown.Item>
          )}
          {contextMenu.message.localType !== 3 && contextMenu.message.localType !== 43 && (
            <Dropdown.Item
              id="multi-select"
              textValue="多选"
              onAction={() => {
                onEnterSelectMode(contextMenu.message.localId)
                closeMenu()
              }}
            >
              <SquareCheck className="size-4 shrink-0 text-muted" />
              <Label>多选</Label>
            </Dropdown.Item>
          )}

          {contextMenu.message.localType === 34 && (
            <Dropdown.Item
              id="export-voice"
              textValue="导出语音文件"
              onAction={() => {
                closeMenu()
                void exportVoiceMessage(contextMenu.message, contextMenu.session)
              }}
            >
              <ArrowDownToLine className="size-4 shrink-0 text-muted" />
              <Label>导出语音文件</Label>
            </Dropdown.Item>
          )}

          {contextMenu.handlers?.reTranscribe && (
            <Dropdown.Item
              id="re-transcribe"
              textValue="重新转文字"
              onAction={() => {
                contextMenu.handlers!.reTranscribe!()
                closeMenu()
              }}
            >
              <ArrowsRotateLeft className="size-4 shrink-0 text-muted" />
              <Label>重新转文字</Label>
            </Dropdown.Item>
          )}

          {contextMenu.handlers?.editStt && (
            <Dropdown.Item
              id="edit-stt"
              textValue="修改识别文字"
              onAction={() => {
                contextMenu.handlers!.editStt!()
                closeMenu()
              }}
            >
              <Pencil className="size-4 shrink-0 text-muted" />
              <Label>修改识别文字</Label>
            </Dropdown.Item>
          )}

          <Dropdown.Item
            id="message-info"
            textValue="查看消息信息"
            onAction={() => {
              setShowMessageInfo(contextMenu.message)
              closeMenu()
            }}
          >
            <CircleInfo className="size-4 shrink-0 text-muted" />
            <Label>查看消息信息</Label>
          </Dropdown.Item>
        </Dropdown.Menu>
      </div>
    </div>,
    document.body
  )
}
