import { ArrowsRotateLeft, CircleInfo } from '@gravity-ui/icons'
import { ScrollShadow, Button, Typography } from '@heroui/react'
import type { ExportShared } from '../hooks/useExportShared'
import type { useDatabaseExport } from '../hooks/useDatabaseExport'
import ExportSearchBar from './ExportSearchBar'
import DatabaseList from './DatabaseList'
import ExportPathSelect from './ExportPathSelect'
import ExportActionButton from './ExportActionButton'

interface DatabaseExportPanelProps {
  database: ReturnType<typeof useDatabaseExport>
  shared: ExportShared
}

export default function DatabaseExportPanel({ database, shared }: DatabaseExportPanelProps) {
  const {
    filteredDatabases,
    selected,
    setSelected,
    searchKeyword,
    setSearchKeyword,
    isLoading,
    loadDatabases,
    toggleSelectAll,
    startDatabaseExport
  } = database

  const allSelected = selected.size === filteredDatabases.length && filteredDatabases.length > 0

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
      {/* 左侧：数据库列表 */}
      <div className="flex min-h-0 flex-col gap-3 overflow-hidden lg:border-r lg:border-default lg:pr-3">
        <div className="flex items-center justify-between">
          <Typography type="h6">数据库列表</Typography>
          <Button isIconOnly variant="tertiary" size="sm" isDisabled={isLoading} onPress={loadDatabases}>
            <ArrowsRotateLeft width={16} height={16} className={isLoading ? 'animate-spin' : ''} />
          </Button>
        </div>

        <ExportSearchBar
          aria-label="搜索数据库"
          value={searchKeyword}
          onChange={setSearchKeyword}
          placeholder="搜索数据库..."
        />

        <div className="flex items-center justify-between gap-2">
          <Button variant="tertiary" size="sm" onPress={toggleSelectAll}>{allSelected ? '取消全选' : '全选'}</Button>
          <Typography type="body-xs" className="shrink-0 text-muted">
            {selected.size > 0 ? `已选 ${selected.size} 个` : `共 ${filteredDatabases.length} 个数据库`}
          </Typography>
        </div>

        <ScrollShadow hideScrollBar className="min-h-0 flex-1" size={32}>
          <DatabaseList
            isLoading={isLoading}
            databases={filteredDatabases}
            selected={selected}
            onSelectionChange={setSelected}
          />
        </ScrollShadow>
      </div>

      {/* 右侧：导出设置 */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        <ScrollShadow hideScrollBar className="min-h-0 flex-1" size={32}>
          <div className="flex flex-col gap-5 px-1 py-1">
            <section className="flex items-start gap-2 rounded-lg bg-default p-3">
              <CircleInfo width={16} height={16} className="mt-0.5 shrink-0 text-muted" />
              <Typography type="body-sm" className="text-muted">
                将微信原生加密数据库解密为普通 SQLite 库导出。每个勾选的库各导出为一个明文 .db 文件，
                可用任意 SQLite 工具直接打开。
              </Typography>
            </section>

            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">导出位置</Typography>
              <ExportPathSelect exportFolder={shared.exportFolder} onSelect={shared.selectExportFolder} />
            </section>
          </div>
        </ScrollShadow>

        <div className="border-t border-default pt-3">
          <ExportActionButton
            label="导出数据库"
            isExporting={shared.isExporting}
            disabled={!shared.exportFolder || selected.size === 0 || shared.isExporting}
            onClick={startDatabaseExport}
          />
        </div>
      </div>
    </div>
  )
}
