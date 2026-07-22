import { Database as DatabaseIcon } from '@gravity-ui/icons'
import { Spinner, ListBox, Chip, Label, Description, Typography, type Selection } from '@heroui/react'
import type { DatabaseFile } from '../types'
import { formatBytes } from '../utils'

interface DatabaseListProps {
  isLoading: boolean
  databases: DatabaseFile[]
  selected: Set<string>
  onSelectionChange: (next: Set<string>) => void
}

export default function DatabaseList({ isLoading, databases, selected, onSelectionChange }: DatabaseListProps) {
  if (isLoading) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
        <Spinner size="md" />
        <Typography type="body-sm">扫描中...</Typography>
      </div>
    )
  }

  if (databases.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted">
        <Typography type="body-sm">未发现数据库</Typography>
      </div>
    )
  }

  const handleChange = (keys: Selection) => {
    const next = keys === 'all' ? new Set(databases.map((d) => d.path)) : new Set(Array.from(keys, String))
    onSelectionChange(next)
  }

  return (
    <ListBox
      aria-label="数据库列表"
      selectionMode="multiple"
      selectedKeys={selected}
      onSelectionChange={handleChange}
      className="w-full"
    >
      {databases.map((db) => (
        <ListBox.Item
          key={db.path}
          id={db.path}
          textValue={db.name}
          className="data-[selected=true]:bg-accent-soft data-[selected=true]:text-accent-soft-foreground"
        >
          <DatabaseIcon width={16} height={16} className="shrink-0 text-muted" />
          <div className="flex min-w-0 flex-1 flex-col">
            <Label className="truncate">{db.name}</Label>
            {db.folder && <Description className="truncate">{db.folder}</Description>}
          </div>
          <Chip variant="secondary" size="sm" className="shrink-0">
            {formatBytes(db.size)}
          </Chip>
          <ListBox.ItemIndicator />
        </ListBox.Item>
      ))}
    </ListBox>
  )
}
