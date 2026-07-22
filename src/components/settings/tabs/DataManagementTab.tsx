import { useEffect, useState, type ReactNode } from 'react'
import { Alert, AlertDialog, Button, Card, Chip, Description, InputGroup, Label, ListBox, Radio, RadioGroup, ScrollShadow, Tabs, TextField, Typography, type Key } from '@heroui/react'
import { ArrowRotateLeft, ArrowsRotateLeft, Database, FaceSmile, FolderOpen, Key as KeyIcon, Layers, Picture, TrashBin } from '@gravity-ui/icons'
import { dialog } from '../../../services/ipc'
import { formatFileSize } from '../utils'
import { useSettingsStore } from '../settingsStore'

interface DataManagementTabProps {
  showMessage: (text: string, success: boolean) => void
  reloadConfig: () => Promise<unknown>
  onClearCurrentAccountConfig: (deleteLocalData?: boolean) => void
}

type DataManagementTabKey = 'export' | 'cache' | 'logs'
type ClearDialogType = 'images' | 'emojis' | 'aiData' | 'all' | 'currentAccount' | 'currentAccountWithData' | 'allAccounts' | 'logs'

interface ClearDialogState {
  type: ClearDialogType
  title: string
  message: string
  confirmLabel?: string
  confirmVariant?: 'primary' | 'danger'
}

const dateRangeOptions = [
  { value: 0, label: '不限制', desc: '全部消息' },
  { value: 1, label: '今天', desc: '仅今日消息' },
  { value: 7, label: '最近7天', desc: '过去一周' },
  { value: 30, label: '最近30天', desc: '过去一个月' },
  { value: 90, label: '最近90天', desc: '过去三个月' },
  { value: 180, label: '最近180天', desc: '过去半年' },
  { value: 365, label: '最近1年', desc: '过去一年' }
]

const logLevelOptions = [
  { value: 'DEBUG', label: 'DEBUG', desc: '输出最详细的调试信息' },
  { value: 'INFO', label: 'INFO', desc: '输出常规运行信息' },
  { value: 'WARN', label: 'WARN', desc: '仅记录警告与错误' },
  { value: 'ERROR', label: 'ERROR', desc: '仅记录错误' }
]

function DataManagementTab({ showMessage, reloadConfig }: DataManagementTabProps) {
  const exportPath = useSettingsStore(s => s.config.exportPath)
  const exportDefaultDateRange = useSettingsStore(s => s.config.exportDefaultDateRange)
  const setField = useSettingsStore(s => s.setField)
  const setExportPath = (value: string) => setField('exportPath', value)
  const setExportDefaultDateRange = (value: number) => setField('exportDefaultDateRange', value)

  const [activePanel, setActivePanel] = useState<DataManagementTabKey>('cache')
  const [defaultExportPath, setDefaultExportPath] = useState('')
  const [showClearDialog, setShowClearDialog] = useState<ClearDialogState | null>(null)
  const [cacheSize, setCacheSize] = useState<{ images: number; emojis: number; databases: number; aiData: number; logs: number; total: number } | null>(null)
  const [isLoadingCacheSize, setIsLoadingCacheSize] = useState(false)
  const [logFiles, setLogFiles] = useState<Array<{ name: string; size: number; mtime: Date }>>([])
  const [selectedLogFile, setSelectedLogFile] = useState('')
  const [logContent, setLogContent] = useState('')
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)
  const [isLoadingLogContent, setIsLoadingLogContent] = useState(false)
  const [logSize, setLogSize] = useState(0)
  const [currentLogLevel, setCurrentLogLevel] = useState('WARN')

  useEffect(() => {
    loadDefaultExportPath()
    loadCacheSize()
    loadLogFiles()
  }, [])

  const loadDefaultExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setDefaultExportPath(downloadsPath)
    } catch (e) {
      console.error('获取默认导出路径失败:', e)
    }
  }

  const loadCacheSize = async () => {
    setIsLoadingCacheSize(true)
    try {
      const result = await window.electronAPI.cache.getCacheSize()
      if (result.success && result.size) setCacheSize(result.size)
    } catch (e) {
      console.error('获取缓存大小失败:', e)
    } finally {
      setIsLoadingCacheSize(false)
    }
  }

  const loadLogFiles = async () => {
    setIsLoadingLogs(true)
    try {
      const result = await window.electronAPI.log.getLogFiles()
      if (result.success && result.files) {
        setLogFiles(result.files.map((file: any) => ({ ...file, mtime: new Date(file.mtime) })))
        setLogSize(result.files.reduce((total: number, file: any) => total + file.size, 0))
      }
      const levelResult = await window.electronAPI.log.getLogLevel()
      if (levelResult.success && levelResult.level) setCurrentLogLevel(levelResult.level)
    } catch (e) {
      console.error('加载日志文件失败:', e)
    } finally {
      setIsLoadingLogs(false)
    }
  }

  const loadLogContent = async (filename: string) => {
    setIsLoadingLogContent(true)
    try {
      const result = await window.electronAPI.log.readLogFile(filename)
      if (result.success && result.content !== undefined) setLogContent(result.content)
    } catch (e) {
      console.error('读取日志文件失败:', e)
      showMessage('读取日志文件失败', false)
    } finally {
      setIsLoadingLogContent(false)
    }
  }

  const handleLogFileSelect = (filename: string) => {
    setSelectedLogFile(filename)
    loadLogContent(filename)
  }

  const handleOpenLogDirectory = async () => {
    try {
      const result = await window.electronAPI.log.getLogDirectory()
      if (result.success && result.directory) {
        await window.electronAPI.shell.openPath(result.directory)
      } else {
        showMessage(result.error || '打开日志目录失败', false)
      }
    } catch (e) {
      showMessage('打开日志目录失败', false)
    }
  }

  const handleLogLevelChange = async (level: string) => {
    try {
      const result = await window.electronAPI.log.setLogLevel(level)
      if (result.success) {
        setCurrentLogLevel(level)
        showMessage(`日志级别已设置为 ${level}`, true)
      } else {
        showMessage(result.error || '设置日志级别失败', false)
      }
    } catch (e) {
      showMessage('设置日志级别失败', false)
    }
  }

  const handleClearLogs = () => {
    setShowClearDialog({
      type: 'logs',
      title: '清除所有日志',
      message: '此操作将删除所有日志文件，清除后无法恢复。确定要继续吗？',
      confirmLabel: '清除日志',
      confirmVariant: 'danger'
    })
  }

  const handleSelectExportPath = async () => {
    try {
      const result = await dialog.openFile({ title: '选择导出目录', properties: ['openDirectory'] })
      if (!result.canceled && result.filePaths.length > 0) {
        setExportPath(result.filePaths[0])
        showMessage('已设置导出目录', true)
      }
    } catch (e) {
      showMessage('选择目录失败', false)
    }
  }

  const handleResetExportPath = async () => {
    try {
      const downloadsPath = await window.electronAPI.app.getDownloadsPath()
      setExportPath(downloadsPath)
      showMessage('已恢复为下载目录', true)
    } catch (e) {
      showMessage('恢复默认失败', false)
    }
  }

  const handleClearImages = () => setShowClearDialog({ type: 'images', title: '清除图片', message: '此操作将删除所有解密后的图片文件，清除后无法恢复。确定要继续吗？', confirmLabel: '清除图片', confirmVariant: 'danger' })
  const handleClearEmojis = () => setShowClearDialog({ type: 'emojis', title: '清除表情包', message: '此操作将删除所有解密后的表情包缓存文件，清除后无法恢复。确定要继续吗？', confirmLabel: '清除表情包', confirmVariant: 'danger' })
  const handleClearAIData = () => setShowClearDialog({
    type: 'aiData',
    title: '清除 AI 数据',
    message: '此操作将删除历史 AI 摘要、AI 记忆、语义索引等功能产生的本地数据，不会删除 AI 接入配置、API Key、模型和服务地址。确定要继续吗？',
    confirmLabel: '清除 AI 数据',
    confirmVariant: 'danger'
  })
  const handleClearAllCache = () => setShowClearDialog({ type: 'all', title: '清除所有缓存', message: '此操作将删除所有缓存数据（包括解密后的图片、表情包、日志和历史 AI 功能数据库），清除后无法恢复。确定要继续吗？', confirmLabel: '清除所有缓存', confirmVariant: 'danger' })
  const handleClearCurrentAccount = () => setShowClearDialog({ type: 'currentAccount', title: '清除当前账号', message: '此操作将清除当前账号的密钥、路径等配置，不影响其他账号。确定要继续吗？', confirmLabel: '清除当前账号', confirmVariant: 'danger' })
  const handleClearCurrentAccountWithData = () => setShowClearDialog({ type: 'currentAccountWithData', title: '删除当前账号并清理数据', message: '此操作将清除当前账号配置，并尝试删除该账号对应的本地解密数据库缓存。确定要继续吗？', confirmLabel: '删除并清理', confirmVariant: 'danger' })
  const handleClearAllAccounts = () => setShowClearDialog({ type: 'allAccounts', title: '清空全部账号配置', message: '此操作将删除所有账号配置和账号级密钥/路径信息，不删除全局主题、AI、MCP、HTTP API 等通用设置。确定要继续吗？', confirmLabel: '清空全部账号', confirmVariant: 'danger' })

  const confirmClear = async () => {
    if (!showClearDialog) return

    const currentDialog = showClearDialog
    setShowClearDialog(null)

    try {
      let result
      switch (currentDialog.type) {
        case 'images': result = await window.electronAPI.cache.clearImages(); break
        case 'emojis': result = await window.electronAPI.cache.clearEmojis(); break
        case 'aiData': result = await window.electronAPI.cache.clearAIData(); break
        case 'all': result = await window.electronAPI.cache.clearAll(); break
        case 'currentAccount': result = await window.electronAPI.cache.clearCurrentAccount(false); break
        case 'currentAccountWithData': result = await window.electronAPI.cache.clearCurrentAccount(true); break
        case 'allAccounts': result = await window.electronAPI.cache.clearAllAccountConfigs(); break
        case 'logs': result = await window.electronAPI.log.clearLogs(); break
      }

      if (result.success) {
        showMessage(`${currentDialog.title}成功`, true)
        if (currentDialog.type === 'logs') {
          setLogFiles([])
          setLogContent('')
          setSelectedLogFile('')
          setLogSize(0)
          await loadCacheSize()
        } else if (currentDialog.type === 'currentAccount' || currentDialog.type === 'currentAccountWithData' || currentDialog.type === 'allAccounts') {
          await reloadConfig()
          await loadCacheSize()
        } else {
          await loadCacheSize()
          if (currentDialog.type === 'all') {
            setLogFiles([])
            setLogContent('')
            setSelectedLogFile('')
            setLogSize(0)
          }
        }
      } else {
        showMessage(result.error || `${currentDialog.title}失败`, false)
      }
    } catch (e) {
      showMessage(`${currentDialog.title}失败: ${e}`, false)
    }
  }

  const renderExportPanel = () => (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="h-fit">
        <Card.Header>
          <Card.Title>导出目录</Card.Title>
          <Card.Description>聊天记录导出的默认保存位置。</Card.Description>
        </Card.Header>
        <Card.Content>
          <TextField fullWidth value={exportPath || defaultExportPath} onChange={setExportPath}>
            <Label>目录路径</Label>
            <InputGroup fullWidth variant="secondary">
              <InputGroup.Input placeholder={defaultExportPath || '系统下载目录'} />
              <InputGroup.Suffix className="pr-0">
                <Button type="button" variant="ghost" size="sm" isIconOnly aria-label="选择导出目录" onPress={handleSelectExportPath}>
                  <FolderOpen width={16} height={16} />
                </Button>
                <Button type="button" variant="ghost" size="sm" isIconOnly aria-label="恢复默认目录" onPress={() => void handleResetExportPath()}>
                  <ArrowRotateLeft width={16} height={16} />
                </Button>
              </InputGroup.Suffix>
            </InputGroup>
            <Description>留空或恢复默认时使用系统下载目录。</Description>
          </TextField>
        </Card.Content>
      </Card>

      <Card className="h-fit">
        <Card.Header>
          <Card.Title>默认日期范围</Card.Title>
          <Card.Description>导出时自动填充的日期范围，0 表示不限制。</Card.Description>
        </Card.Header>
        <Card.Content>
          <RadioGroup
            name="exportDefaultDateRange"
            value={String(exportDefaultDateRange)}
            onChange={(value) => setExportDefaultDateRange(Number(value))}
            variant="secondary"
            className="grid gap-3"
          >
            {dateRangeOptions.map(option => (
              <Radio key={option.value} value={String(option.value)} className="relative">
                <Radio.Control className="absolute top-4 right-4">
                  <Radio.Indicator />
                </Radio.Control>
                <Radio.Content className="pr-8">
                  <Label>{option.label}</Label>
                  <Description>{option.desc}</Description>
                </Radio.Content>
              </Radio>
            ))}
          </RadioGroup>
        </Card.Content>
      </Card>
    </div>
  )

  const renderCacheCard = ({
    icon,
    title,
    size,
    description,
    actionLabel,
    actionVariant = 'secondary',
    onAction
  }: {
    icon: ReactNode
    title: string
    size?: number
    description?: string
    actionLabel: string
    actionVariant?: 'secondary' | 'danger'
    onAction: () => void
  }) => (
    <Card className="h-full">
      <Card.Header className="flex-row items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-default text-foreground">
            {icon}
          </div>
          <div className="min-w-0">
            <Card.Title>{title}</Card.Title>
            {description && <Card.Description>{description}</Card.Description>}
          </div>
        </div>
        {typeof size === 'number' && (
          <Chip size="sm" variant="soft">
            <Chip.Label>{formatFileSize(size)}</Chip.Label>
          </Chip>
        )}
      </Card.Header>
      <Card.Footer className="mt-auto">
        <Button type="button" variant={actionVariant} size="sm" fullWidth onPress={onAction}>
          <TrashBin width={16} height={16} /> {actionLabel}
        </Button>
      </Card.Footer>
    </Card>
  )

  const renderCachePanel = () => (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Typography.Heading level={3} className="text-lg font-semibold text-foreground">缓存管理</Typography.Heading>
          <Typography.Paragraph size="sm" color="muted">查看缓存占用并清理本地生成数据。</Typography.Paragraph>
        </div>
        <Button type="button" variant="outline" size="sm" onPress={() => void loadCacheSize()} isDisabled={isLoadingCacheSize}>
          <ArrowsRotateLeft width={16} height={16} className={isLoadingCacheSize ? 'spin' : undefined} /> 刷新缓存大小
        </Button>
      </div>

      {isLoadingCacheSize ? (
        <Alert status="default">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>正在计算缓存大小...</Alert.Title>
          </Alert.Content>
        </Alert>
      ) : cacheSize ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {renderCacheCard({
            icon: <Picture width={20} height={20} />,
            title: '图片缓存',
            size: cacheSize.images,
            description: '解密后的图片文件',
            actionLabel: '清除图片',
            onAction: handleClearImages
          })}
          {renderCacheCard({
            icon: <FaceSmile width={20} height={20} />,
            title: '表情包缓存',
            size: cacheSize.emojis,
            description: '解密后的表情包文件',
            actionLabel: '清除表情包',
            onAction: handleClearEmojis
          })}
          {renderCacheCard({
            icon: <Database width={20} height={20} />,
            title: 'AI 数据',
            size: cacheSize.aiData,
            description: '历史摘要、记忆、语义索引',
            actionLabel: '清除 AI 数据',
            onAction: handleClearAIData
          })}
          {renderCacheCard({
            icon: <KeyIcon width={20} height={20} />,
            title: '当前账号配置',
            description: '密钥、路径等账号级配置',
            actionLabel: '清除当前账号',
            onAction: handleClearCurrentAccount
          })}
          {renderCacheCard({
            icon: <KeyIcon width={20} height={20} />,
            title: '当前账号与本地数据',
            description: '配置与该账号对应的本地缓存',
            actionLabel: '删除并清理数据',
            actionVariant: 'danger',
            onAction: handleClearCurrentAccountWithData
          })}
          {renderCacheCard({
            icon: <Layers width={20} height={20} />,
            title: '全部缓存',
            size: cacheSize.total,
            description: '图片、表情包、日志和 AI 数据',
            actionLabel: '清除所有缓存',
            actionVariant: 'danger',
            onAction: handleClearAllCache
          })}
          {renderCacheCard({
            icon: <KeyIcon width={20} height={20} />,
            title: '全部账号配置',
            description: '所有账号级密钥和路径信息',
            actionLabel: '清空全部账号配置',
            actionVariant: 'danger',
            onAction: handleClearAllAccounts
          })}
        </div>
      ) : (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>无法获取缓存信息</Alert.Title>
            <Alert.Description>可以稍后刷新重试。</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
    </div>
  )

  const renderLogsPanel = () => (
    <div className="grid gap-5 xl:grid-cols-[340px_minmax(0,1fr)]">
      <div className="space-y-5">
        <Card>
          <Card.Header>
            <Card.Title>日志概览</Card.Title>
            <Card.Description>当前日志文件与记录级别。</Card.Description>
          </Card.Header>
          <Card.Content className="grid gap-3">
            <div className="flex items-center justify-between gap-3">
              <Typography.Paragraph size="sm" color="muted">日志文件</Typography.Paragraph>
              <Chip size="sm" variant="soft"><Chip.Label>{logFiles.length} 个</Chip.Label></Chip>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Typography.Paragraph size="sm" color="muted">总大小</Typography.Paragraph>
              <Chip size="sm" variant="soft"><Chip.Label>{formatFileSize(logSize)}</Chip.Label></Chip>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Typography.Paragraph size="sm" color="muted">当前级别</Typography.Paragraph>
              <Chip size="sm" variant="soft" color="warning"><Chip.Label>{currentLogLevel}</Chip.Label></Chip>
            </div>
          </Card.Content>
          <Card.Footer className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onPress={handleOpenLogDirectory}>
              <FolderOpen width={16} height={16} /> 打开目录
            </Button>
            <Button type="button" variant="outline" size="sm" onPress={() => void loadLogFiles()} isDisabled={isLoadingLogs}>
              <ArrowsRotateLeft width={16} height={16} className={isLoadingLogs ? 'spin' : undefined} /> 刷新
            </Button>
            <Button type="button" variant="danger" size="sm" onPress={handleClearLogs}>
              <TrashBin width={16} height={16} /> 清除日志
            </Button>
          </Card.Footer>
        </Card>

        <Card>
          <Card.Header>
            <Card.Title>日志级别</Card.Title>
            <Card.Description>修改后立即写入当前日志配置。</Card.Description>
          </Card.Header>
          <Card.Content>
            <RadioGroup
              name="logLevel"
              value={currentLogLevel}
              onChange={(level) => void handleLogLevelChange(level)}
              variant="secondary"
              className="grid gap-3"
            >
              {logLevelOptions.map(option => (
                <Radio key={option.value} value={option.value} className="relative">
                  <Radio.Control className="absolute top-4 right-4">
                    <Radio.Indicator />
                  </Radio.Control>
                  <Radio.Content className="pr-8">
                    <Label>{option.label}</Label>
                    <Description>{option.desc}</Description>
                  </Radio.Content>
                </Radio>
              ))}
            </RadioGroup>
          </Card.Content>
        </Card>
      </div>

      <Card className="min-w-0">
        <Card.Header>
          <Card.Title>最近日志</Card.Title>
          <Card.Description>选择一个日志文件查看内容。</Card.Description>
        </Card.Header>
        <Card.Content className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
          <ScrollShadow className="max-h-80 rounded-lg border border-border">
            {isLoadingLogs ? (
              <div className="p-4">
                <Description>正在加载日志文件...</Description>
              </div>
            ) : logFiles.length > 0 ? (
              <ListBox
                aria-label="日志文件"
                selectionMode="single"
                selectedKeys={selectedLogFile ? [selectedLogFile] : []}
                onSelectionChange={(keys) => {
                  if (keys === 'all') return
                  const filename = Array.from(keys)[0]
                  if (filename != null) handleLogFileSelect(String(filename))
                }}
              >
                {logFiles.map(file => (
                  <ListBox.Item key={file.name} id={file.name} textValue={file.name}>
                    <div className="flex min-w-0 flex-col">
                      <span className="truncate text-sm text-foreground">{file.name}</span>
                      <span className="text-xs text-muted">{formatFileSize(file.size)}</span>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            ) : (
              <div className="p-4">
                <Description>暂无日志文件</Description>
              </div>
            )}
          </ScrollShadow>

          <ScrollShadow className="max-h-80 min-h-80 rounded-lg border border-border bg-default">
            {selectedLogFile ? (
              isLoadingLogContent ? (
                <div className="p-4">
                  <Description>正在读取日志内容...</Description>
                </div>
              ) : (
                <pre className="m-0 select-text whitespace-pre-wrap break-words p-4 font-mono text-xs leading-6 text-foreground">{logContent}</pre>
              )
            ) : (
              <div className="p-4">
                <Description>请选择左侧日志文件。</Description>
              </div>
            )}
          </ScrollShadow>
        </Card.Content>
      </Card>
    </div>
  )

  const renderConfirmDialog = () => {
    if (!showClearDialog) return null

    return (
      <AlertDialog isOpen={Boolean(showClearDialog)} onOpenChange={(open) => {
        if (!open) setShowClearDialog(null)
      }}>
        <Button className="hidden" aria-hidden="true">打开确认框</Button>
        <AlertDialog.Backdrop>
          <AlertDialog.Container>
            <AlertDialog.Dialog className="sm:max-w-105">
              <AlertDialog.CloseTrigger />
              <AlertDialog.Header>
                <AlertDialog.Icon status="danger" />
                <AlertDialog.Heading>{showClearDialog.title}</AlertDialog.Heading>
              </AlertDialog.Header>
              <AlertDialog.Body>
                <Typography.Paragraph>{showClearDialog.message}</Typography.Paragraph>
              </AlertDialog.Body>
              <AlertDialog.Footer>
                <Button slot="close" variant="tertiary">取消</Button>
                <Button slot="close" variant={showClearDialog.confirmVariant || 'danger'} onPress={() => void confirmClear()}>
                  {showClearDialog.confirmLabel || '确定'}
                </Button>
              </AlertDialog.Footer>
            </AlertDialog.Dialog>
          </AlertDialog.Container>
        </AlertDialog.Backdrop>
      </AlertDialog>
    )
  }

  return (
    <div className="tab-content space-y-6">
      <section className="space-y-2">
        <Typography.Heading level={3} className="text-lg font-semibold text-foreground">数据管理</Typography.Heading>
        <Typography.Paragraph size="sm" color="muted">
          管理导出默认值、本地缓存和运行日志。
        </Typography.Paragraph>
      </section>

      <Tabs selectedKey={activePanel} onSelectionChange={(key: Key) => setActivePanel(String(key) as DataManagementTabKey)} className="w-full">
        <Tabs.ListContainer>
          <Tabs.List aria-label="数据管理分类" className="w-full *:flex-1 *:gap-2">
            <Tabs.Tab id="export"><FolderOpen width={16} height={16} aria-hidden />导出设置<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="cache"><Database width={16} height={16} aria-hidden />缓存管理<Tabs.Indicator /></Tabs.Tab>
            <Tabs.Tab id="logs"><ArrowsRotateLeft width={16} height={16} aria-hidden />日志管理<Tabs.Indicator /></Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>

        <Tabs.Panel id="export" className="pt-5">
          {renderExportPanel()}
        </Tabs.Panel>
        <Tabs.Panel id="cache" className="pt-5">
          {renderCachePanel()}
        </Tabs.Panel>
        <Tabs.Panel id="logs" className="pt-5">
          {renderLogsPanel()}
        </Tabs.Panel>
      </Tabs>

      {renderConfirmDialog()}
    </div>
  )
}

export default DataManagementTab
