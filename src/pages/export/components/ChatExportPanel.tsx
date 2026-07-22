import { ArrowsRotateLeft, FaceSmile, Microphone, Person, Persons, Picture, Video } from '@gravity-ui/icons'
import { ScrollShadow, Button, Tabs, Chip, Typography } from '@heroui/react'
import DateRangePicker from '../../../components/DateRangePicker'
import type { ExportOptions, SessionTypeFilter } from '../types'
import type { ExportShared } from '../hooks/useExportShared'
import type { useChatExport } from '../hooks/useChatExport'
import { chatFormatOptions } from '../constants'
import ExportSearchBar from './ExportSearchBar'
import SessionList from './SessionList'
import FormatPicker from './FormatPicker'
import OptionCardGroup from './OptionCardGroup'
import ExportPathSelect from './ExportPathSelect'
import ExportActionButton from './ExportActionButton'

interface ChatExportPanelProps {
  chat: ReturnType<typeof useChatExport>
  shared: ExportShared
}

const exportToggles: { key: keyof ExportOptions; label: string; icon: typeof Picture }[] = [
  { key: 'exportAvatars', label: '导出头像', icon: Person },
  { key: 'exportImages', label: '导出图片', icon: Picture },
  { key: 'exportVideos', label: '导出视频', icon: Video },
  { key: 'exportEmojis', label: '导出表情包', icon: FaceSmile },
  { key: 'exportVoices', label: '导出语音', icon: Microphone }
]

export default function ChatExportPanel({ chat, shared }: ChatExportPanelProps) {
  const {
    filteredSessions,
    selectedSessions,
    isLoading,
    searchKeyword,
    setSearchKeyword,
    sessionTypeFilter,
    setSessionTypeFilter,
    options,
    setOptions,
    loadSessions,
    setSelectedSessions,
    startExport
  } = chat

  const setOption = <K extends keyof ExportOptions>(key: K, value: ExportOptions[K]) =>
    setOptions(prev => ({ ...prev, [key]: value }))

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-3 lg:grid-cols-[360px_minmax(0,1fr)]">
      {/* 左侧：会话预览 */}
      <div className="flex min-h-0 flex-col gap-3 overflow-hidden lg:border-r lg:border-default lg:pr-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Typography type="h6">选择会话</Typography>
            {selectedSessions.size > 0 && (
              <Chip variant="secondary" size="sm">已选 {selectedSessions.size}</Chip>
            )}
          </div>
          <Button isIconOnly variant="tertiary" size="sm" isDisabled={isLoading} onPress={loadSessions}>
            <ArrowsRotateLeft width={16} height={16} className={isLoading ? 'animate-spin' : ''} />
          </Button>
        </div>

        <ExportSearchBar
          aria-label="搜索会话"
          value={searchKeyword}
          onChange={setSearchKeyword}
          placeholder="搜索联系人或群组..."
        />

        <Tabs
          selectedKey={sessionTypeFilter}
          onSelectionChange={(key) => setSessionTypeFilter(String(key) as SessionTypeFilter)}
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="会话类型筛选">
              <Tabs.Tab id="all">全部<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="group"><Persons width={13} height={13} />群聊<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="private"><Person width={13} height={13} />私聊<Tabs.Indicator /></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>

        <ScrollShadow hideScrollBar className="min-h-0 flex-1" size={32}>
          <SessionList
            isLoading={isLoading}
            sessions={filteredSessions}
            selectedSessions={selectedSessions}
            onSelectionChange={setSelectedSessions}
          />
        </ScrollShadow>
      </div>

      {/* 右侧：导出设置 */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        <ScrollShadow hideScrollBar className="min-h-0 flex-1" size={32}>
          <div className="flex flex-col gap-5 px-1 py-1">
            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">导出格式</Typography>
              <FormatPicker
                aria-label="导出格式"
                options={chatFormatOptions}
                value={options.format}
                onChange={(value) => setOption('format', value as ExportOptions['format'])}
              />
            </section>

            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">时间范围</Typography>
              <div className="max-w-xs">
                <DateRangePicker
                  startDate={options.startDate}
                  endDate={options.endDate}
                  onStartDateChange={(date) => setOption('startDate', date)}
                  onEndDateChange={(date) => setOption('endDate', date)}
                />
              </div>
              <Typography type="body-xs" className="text-muted">不选择时间范围则导出全部消息</Typography>
            </section>

            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">导出选项</Typography>
              <OptionCardGroup
                aria-label="导出选项"
                items={exportToggles}
                isSelected={(key) => options[key as keyof ExportOptions] as boolean}
                onToggle={(key, checked) => setOption(key as keyof ExportOptions, checked)}
              />
            </section>

            <section className="flex flex-col gap-2">
              <Typography type="body-sm" weight="semibold">导出位置</Typography>
              <ExportPathSelect exportFolder={shared.exportFolder} onSelect={shared.selectExportFolder} />
            </section>
          </div>
        </ScrollShadow>

        <div className="border-t border-default pt-3">
          <ExportActionButton
            label="开始导出"
            isExporting={shared.isExporting}
            disabled={selectedSessions.size === 0 || !shared.exportFolder || shared.isExporting}
            onClick={startExport}
          />
        </div>
      </div>
    </div>
  )
}
