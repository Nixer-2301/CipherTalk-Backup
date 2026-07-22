import { Spinner, ListBox, Avatar, Label, Description, Typography, type Selection } from '@heroui/react'
import type { ChatSession } from '../types'
import { getAvatarLetter } from '../utils'

interface SessionListProps {
  isLoading: boolean
  sessions: ChatSession[]
  selectedSessions: Set<string>
  onSelectionChange: (next: Set<string>) => void
}

export default function SessionList({ isLoading, sessions, selectedSessions, onSelectionChange }: SessionListProps) {
  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <Spinner size="md" />
        <Typography type="body-sm">加载中...</Typography>
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Typography type="body-sm">暂无会话</Typography>
      </div>
    )
  }

  const visibleSet = new Set(sessions.map(s => s.username))
  // 仅把「当前过滤结果中」已选的项传给 ListBox，避免 React Aria 对不在集合里的 key 告警
  const selectedVisible = new Set([...selectedSessions].filter(u => visibleSet.has(u)))

  const handleChange = (keys: Selection) => {
    const next = keys === 'all' ? new Set(visibleSet) : new Set(Array.from(keys, String))
    // 保留被过滤隐藏掉的已选会话
    for (const u of selectedSessions) if (!visibleSet.has(u)) next.add(u)
    onSelectionChange(next)
  }

  return (
    <ListBox
      aria-label="会话列表"
      selectionMode="multiple"
      selectedKeys={selectedVisible}
      onSelectionChange={handleChange}
      className="w-full"
    >
      {sessions.map(session => {
        const isGroup = session.username.includes('@chatroom')
        return (
          <ListBox.Item
            key={session.username}
            id={session.username}
            textValue={session.displayName || session.username}
            className="data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent-soft-foreground"
          >
            <Avatar size="sm" color={isGroup ? 'accent' : 'default'}>
              {session.avatarUrl && <Avatar.Image alt="" loading="lazy" src={session.avatarUrl} />}
              <Avatar.Fallback>
                {isGroup ? '群' : getAvatarLetter(session.displayName || session.username)}
              </Avatar.Fallback>
            </Avatar>
            <div className="flex min-w-0 flex-1 flex-col">
              <Label className="truncate">{session.displayName || session.username}</Label>
              <Description className="truncate">{session.summary || '暂无消息'}</Description>
            </div>
            <ListBox.ItemIndicator />
          </ListBox.Item>
        )
      })}
    </ListBox>
  )
}
