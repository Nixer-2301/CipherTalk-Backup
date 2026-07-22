/**
 * Agent 对话记录下拉菜单——从 AgentPage.tsx 拆出来，用 React.memo 包裹。
 *
 * 为什么需要这个文件：HeroUI 的 Dropdown.Menu 不支持虚拟化，打开时会把所有 Dropdown.Item
 * 一次性挂到 DOM。对话记录每条又嵌了 Label / 图标 / HeroButton 等多个组件，记录一多（默认 50 条），
 * 首次打开就要同步创建数百个组件实例和 DOM 节点，主线程被占满 → 明显卡顿。
 *
 * 这里做两件事：
 *  1. 限制渲染量——加搜索框 + visible 上限（RECORDS_VISIBLE_LIMIT），打开时最多渲染 30 条，
 *     老记录靠搜索定位，而不是全量渲染后滚动翻找。
 *  2. memo 隔离——AgentPage 流式输出时每 ~50ms 重渲染一次，原本即使菜单关闭，
 *     `conversationRecords.map(...)` 也会重建整棵 Dropdown 元素树（react-aria 的 Popover 在
 *     isOpen=false 时 return null 不挂 DOM，但 JSX 求值在它之前就已发生）。包一层 memo，
 *     只要传入的 props 引用没变，这层重渲染就完全跳过。
 */
import { memo, useEffect, useMemo, useState } from 'react'
import { Button as HeroButton, Dropdown, Label, SearchField } from '@heroui/react'
import { Clock, ClockArrowRotateLeft, TrashBin } from '@gravity-ui/icons'
import type { AgentConversationRecord } from './agentConversationHelpers'

/** 打开时最多渲染多少条 Item——再多就靠搜索框收窄，而不是全量挂 DOM。 */
const RECORDS_VISIBLE_LIMIT = 30

type AgentRecordsMenuProps = {
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  records: AgentConversationRecord[]
  selectedId: number | null
  onOpenRecord: (record: AgentConversationRecord) => void
  onDeleteRecord: (record: AgentConversationRecord) => void
}

function formatRecordTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function AgentRecordsMenuImpl({
  isOpen,
  onOpenChange,
  records,
  selectedId,
  onOpenRecord,
  onDeleteRecord,
}: AgentRecordsMenuProps) {
  // 搜索词放在组件本地：打开时清空，避免上次的关键词残留影响这次查看。
  const [search, setSearch] = useState('')
  useEffect(() => {
    if (isOpen) setSearch('')
  }, [isOpen])

  // 有关键词 → 按标题过滤；无关键词 → 取全部。最后统一 slice 到可见上限。
  const { visibleRecords, totalCount, isFiltered, hasMore } = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    const filtered = keyword
      ? records.filter((record) => record.title.toLowerCase().includes(keyword))
      : records
    return {
      visibleRecords: filtered.slice(0, RECORDS_VISIBLE_LIMIT),
      totalCount: filtered.length,
      isFiltered: keyword.length > 0,
      hasMore: filtered.length > RECORDS_VISIBLE_LIMIT,
    }
  }, [records, search])

  const isEmpty = records.length === 0
  const noMatch = !isEmpty && visibleRecords.length === 0

  return (
    <Dropdown isOpen={isOpen} onOpenChange={onOpenChange}>
      <HeroButton
        aria-label="对话记录"
        className="group relative size-9 overflow-visible p-0"
        isIconOnly
        render={(buttonProps) => <button {...buttonProps} title="对话记录" />}
        size="md"
        variant="tertiary"
      >
        <ClockArrowRotateLeft className="size-4.5" />
        <span
          aria-hidden
          className="pointer-events-none absolute top-[calc(100%+0.375rem)] right-0 z-50 whitespace-nowrap rounded-(--agent-radius,12px) border border-border bg-popover px-2 py-1 text-popover-foreground text-xs opacity-0 shadow-lg transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
        >
          对话记录
        </span>
      </HeroButton>
      <Dropdown.Popover className="w-[min(28rem,calc(100vw-2rem))]" placement="bottom end">
        {/* 搜索框：粘性置顶，滚动列表时保持可见。空状态/无匹配时也保留，方便重新输入。 */}
        <div className="sticky top-0 z-10 border-border border-b bg-popover/95 px-2 py-2 backdrop-blur">
          <SearchField aria-label="搜索对话记录" value={search} onChange={setSearch}>
            <SearchField.Group>
              <SearchField.SearchIcon />
              <SearchField.Input placeholder="搜索对话标题" />
              <SearchField.ClearButton />
            </SearchField.Group>
          </SearchField>
        </div>
        <Dropdown.Menu
          disabledKeys={isEmpty ? ['empty-conversation-records'] : noMatch ? ['no-match-records'] : undefined}
          selectedKeys={selectedId ? [selectedId] : []}
          selectionMode="single"
          className="max-h-[min(70vh,32rem)] overflow-y-auto"
          onAction={(key) => {
            const record = records.find((item) => String(item.id) === String(key))
            if (record) onOpenRecord(record)
          }}
        >
          {isEmpty ? (
            <Dropdown.Item
              className="min-h-20 justify-center py-6 text-center text-muted-foreground text-sm"
              id="empty-conversation-records"
              key="empty-conversation-records"
              textValue="暂无对话记录"
            >
              暂无对话记录
            </Dropdown.Item>
          ) : noMatch ? (
            <Dropdown.Item
              className="min-h-20 justify-center py-6 text-center text-muted-foreground text-sm"
              id="no-match-records"
              key="no-match-records"
              textValue="没有匹配的对话"
            >
              没有匹配的对话
            </Dropdown.Item>
          ) : (
            <>
              {visibleRecords.map((record) => (
                <Dropdown.Item
                  className="min-h-14 gap-3 py-2.5"
                  id={record.id}
                  key={record.id}
                  textValue={record.title}
                >
                  <Dropdown.ItemIndicator />
                  <Clock className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <Label className="block truncate font-medium text-sm">{record.title}</Label>
                    <span className="block truncate text-muted-foreground text-xs">
                      {formatRecordTime(record.updatedAt)}
                    </span>
                  </span>
                  <span
                    className="ms-auto flex shrink-0"
                    onClick={(event) => event.stopPropagation()}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <HeroButton
                      aria-label={`删除 ${record.title}`}
                      className="size-8 p-0 text-muted-foreground hover:text-danger"
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      onPress={() => onDeleteRecord(record)}
                    >
                      <TrashBin className="size-4" />
                    </HeroButton>
                  </span>
                </Dropdown.Item>
              ))}
              {/* 截断提示：当记录超过可见上限且未在搜索态时，告知用户总数并引导用搜索。 */}
              {hasMore && (
                <Dropdown.Item
                  className="justify-center py-2 text-center text-muted-foreground text-xs"
                  id="records-more-hint"
                  key="records-more-hint"
                  textValue={`还有 ${totalCount - RECORDS_VISIBLE_LIMIT} 条，输入关键词搜索`}
                >
                  {isFiltered
                    ? `还有 ${totalCount - RECORDS_VISIBLE_LIMIT} 条匹配，请细化关键词`
                    : `共 ${totalCount} 条，已显示最近 ${RECORDS_VISIBLE_LIMIT} 条，输入关键词搜索更多`}
                </Dropdown.Item>
              )}
            </>
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

export const AgentRecordsMenu = memo(AgentRecordsMenuImpl)
