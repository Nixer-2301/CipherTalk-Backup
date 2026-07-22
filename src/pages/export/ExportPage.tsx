import { useState } from 'react'
import { Comment, Database } from '@gravity-ui/icons'
import { Tabs } from '@heroui/react'
import type { ExportTab } from './types'
import { useExportShared } from './hooks/useExportShared'
import { useChatExport } from './hooks/useChatExport'
import { useDatabaseExport } from './hooks/useDatabaseExport'
import ChatExportPanel from './components/ChatExportPanel'
import DatabaseExportPanel from './components/DatabaseExportPanel'
import ExportProgressModal from './components/ExportProgressModal'
import ExportResultModal from './components/ExportResultModal'

function ExportPage() {
  const [activeTab, setActiveTab] = useState<ExportTab>('chat')

  const shared = useExportShared()
  const chat = useChatExport(shared)
  const database = useDatabaseExport(shared, activeTab === 'database')

  const unitLabel = activeTab === 'chat' ? '个会话' : '个数据库'
  const currentLabel = activeTab === 'database' ? '当前数据库' : '当前会话'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Tabs
        selectedKey={activeTab}
        onSelectionChange={(key) => setActiveTab(String(key) as ExportTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="导出模式">
            <Tabs.Tab id="chat"><Comment width={14} height={14} />聊天记录<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="database"><Database width={14} height={14} />数据库导出<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="chat" className="min-h-0 flex-1 pt-3">
          <ChatExportPanel chat={chat} shared={shared} />
        </Tabs.Panel>
        <Tabs.Panel id="database" className="min-h-0 flex-1 pt-3">
          <DatabaseExportPanel database={database} shared={shared} />
        </Tabs.Panel>
      </Tabs>

      {/* 导出进度弹窗 */}
      {shared.isExporting && (
        <ExportProgressModal
          progress={shared.exportProgress}
          options={activeTab === 'chat' ? chat.options : undefined}
          currentLabel={currentLabel}
        />
      )}

      {/* 导出结果弹窗 */}
      {shared.exportResult && (
        <ExportResultModal
          result={shared.exportResult}
          unitLabel={unitLabel}
          onOpenFolder={shared.openExportFolder}
          onClose={() => shared.setExportResult(null)}
        />
      )}
    </div>
  )
}

export default ExportPage
