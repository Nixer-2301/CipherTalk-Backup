import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Alert,
  Button,
  Card,
  Description,
  Fieldset,
  Form,
  InputGroup,
  Label,
  ListBox,
  Select,
  Spinner,
  Switch,
  TextField,
  Typography,
} from '@heroui/react'
import { ArrowsRotateLeft, CircleCheck, Terminal, Xmark } from '@gravity-ui/icons'
import type {
  LocalCodingAgentConfig,
  LocalCodingAgentDefinition,
  LocalCodingAgentDetectResult,
} from '@/types/electron'
import {
  getLocalCodingAgentLabel,
  getLocalCodingAgentOptions,
  normalizeLocalCodingAgentConfig,
  summarizeLocalCodingAgentDetection,
} from '@/lib/localCodingAgent'

type LocalCodingAgentSettingsProps = {
  showMessage?: (text: string, success: boolean) => void
}

function clampTimeoutMinutes(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return 30
  return Math.max(1, Math.min(120, Math.round(parsed)))
}

function formatTimeoutMinutes(timeoutMs?: number): string {
  return String(Math.max(1, Math.round((Number(timeoutMs) || 1_800_000) / 60_000)))
}

function detectionStatusClass(item: LocalCodingAgentDetectResult): string {
  return item.found ? 'bg-emerald-500' : 'bg-amber-500'
}

export default function LocalCodingAgentSettings({ showMessage }: LocalCodingAgentSettingsProps) {
  const [config, setConfig] = useState<LocalCodingAgentConfig | null>(null)
  const [detectResults, setDetectResults] = useState<LocalCodingAgentDetectResult[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [detecting, setDetecting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.electronAPI.localCodingAgent.getConfig()
      .then((result) => {
        if (cancelled) return
        if (!result.success) {
          setError(result.error || '读取本地智能体配置失败')
          setConfig(normalizeLocalCodingAgentConfig(null))
          return
        }
        setConfig(normalizeLocalCodingAgentConfig(result.config))
      })
      .catch((loadError) => {
        if (cancelled) return
        setError(loadError instanceof Error ? loadError.message : '读取本地智能体配置失败')
        setConfig(normalizeLocalCodingAgentConfig(null))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const agentOptions = useMemo(() => getLocalCodingAgentOptions(config), [config])
  const activeAgentId = config?.activeAgent || 'codex'
  const activeAgent = config?.agents?.[activeAgentId]
  const activeAgentLabel = getLocalCodingAgentLabel(config, activeAgentId)

  const updateConfig = (updater: (current: LocalCodingAgentConfig) => LocalCodingAgentConfig) => {
    setConfig((current) => updater(normalizeLocalCodingAgentConfig(current)))
    setError('')
  }

  const updateAgent = (patch: Partial<LocalCodingAgentDefinition>) => {
    updateConfig((current) => {
      const currentAgent = current.agents[current.activeAgent]
      if (!currentAgent) return current
      return {
        ...current,
        agents: {
          ...current.agents,
          [current.activeAgent]: {
            ...currentAgent,
            ...patch,
          },
        },
      }
    })
  }

  const saveConfig = async (nextConfig = config) => {
    if (!nextConfig) return false
    setSaving(true)
    setError('')
    try {
      const normalized = normalizeLocalCodingAgentConfig(nextConfig)
      const result = await window.electronAPI.localCodingAgent.setConfig(normalized)
      if (!result.success || !result.config) {
        setError(result.error || '保存本地智能体配置失败')
        showMessage?.(result.error || '保存本地智能体配置失败', false)
        return false
      }
      const saved = normalizeLocalCodingAgentConfig(result.config)
      setConfig(saved)
      showMessage?.('本地智能体配置已保存', true)
      return true
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : '保存本地智能体配置失败'
      setError(message)
      showMessage?.(message, false)
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    void saveConfig()
  }

  const detectAgents = async () => {
    if (!config) return
    setDetecting(true)
    setError('')
    try {
      const result = await window.electronAPI.localCodingAgent.detect()
      if (!result.success) {
        setError(result.error || '探测本地智能体失败')
        showMessage?.(result.error || '探测本地智能体失败', false)
        return
      }
      const results = result.results || []
      setDetectResults(results)
      const nextAgents = { ...config.agents }
      for (const item of results) {
        if (item.found && nextAgents[item.id]) {
          nextAgents[item.id] = {
            ...nextAgents[item.id],
            executablePath: item.executablePath,
          }
        }
      }
      const firstFound = results.find((item) => item.found && nextAgents[item.id])
      const nextConfig = normalizeLocalCodingAgentConfig({
        ...config,
        activeAgent: firstFound?.id || config.activeAgent,
        agents: nextAgents,
      })
      setConfig(nextConfig)
      await saveConfig(nextConfig)
      showMessage?.(summarizeLocalCodingAgentDetection(results), results.some((item) => item.found))
    } catch (detectError) {
      const message = detectError instanceof Error ? detectError.message : '探测本地智能体失败'
      setError(message)
      showMessage?.(message, false)
    } finally {
      setDetecting(false)
    }
  }

  if (loading || !config) {
    return (
      <Card>
        <Card.Content className="flex min-h-40 items-center justify-center gap-2 text-muted-foreground text-sm">
          <Spinner size="sm" />
          正在读取本地智能体配置...
        </Card.Content>
      </Card>
    )
  }

  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_330px]">
      <Card>
        <Card.Header className="flex-row items-start justify-between gap-4">
          <div className="min-w-0">
            <Card.Title>本地编码智能体</Card.Title>
            <Card.Description>接入本机已安装的 Codex CLI、Claude Code 或 OpenCode，Agent 页可像选择模型一样使用。</Card.Description>
          </div>
          <Terminal className="size-6 shrink-0 text-muted" />
        </Card.Header>
        <Form onSubmit={handleSubmit}>
          <Card.Content>
            <Fieldset className="w-full">
              <Fieldset.Group className="grid gap-4">
                <Switch
                  isSelected={config.enabled}
                  onChange={(enabled) => updateConfig((current) => ({ ...current, enabled }))}
                >
                  <Switch.Content>
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    启用本地智能体
                  </Switch.Content>
                  <Description>启用后，Agent 模型下拉里会出现本地智能体。</Description>
                </Switch>

                <Select
                  fullWidth
                  onSelectionChange={(key) => {
                    if (key != null) updateConfig((current) => ({ ...current, activeAgent: String(key) }))
                  }}
                  placeholder="请选择本地智能体"
                  selectedKey={activeAgentId}
                  variant="secondary"
                >
                  <Label>默认智能体</Label>
                  <Select.Trigger>
                    <Select.Value>{activeAgentLabel}</Select.Value>
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {agentOptions.map((option) => (
                        <ListBox.Item id={option.id} key={option.id} textValue={`${option.label} ${option.detail}`}>
                          <div className="min-w-0">
                            <div className="truncate text-sm">{option.label}</div>
                            <div className="truncate text-muted-foreground text-xs">{option.detail}</div>
                          </div>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>

                {activeAgent && (
                  <div className="grid gap-4 lg:grid-cols-2">
                    <TextField fullWidth value={activeAgent.executablePath} onChange={(value) => updateAgent({ executablePath: value })}>
                      <Label>可执行文件路径</Label>
                      <InputGroup variant="secondary" fullWidth>
                        <InputGroup.Input placeholder="留空时从 PATH 自动查找" />
                      </InputGroup>
                      <Description>例如 codex、claude、opencode，或完整 exe 路径。</Description>
                    </TextField>

                    <TextField fullWidth value={activeAgent.model || ''} onChange={(value) => updateAgent({ model: value })}>
                      <Label>模型参数</Label>
                      <InputGroup variant="secondary" fullWidth>
                        <InputGroup.Input placeholder="可选，例如 gpt-5-codex / sonnet" />
                      </InputGroup>
                      <Description>留空时使用该 CLI 自己的默认模型或订阅配置。</Description>
                    </TextField>

                    <TextField
                      fullWidth
                      value={formatTimeoutMinutes(activeAgent.timeoutMs)}
                      onChange={(value) => updateAgent({ timeoutMs: clampTimeoutMinutes(value) * 60_000 })}
                    >
                      <Label>超时时间（分钟）</Label>
                      <InputGroup variant="secondary" fullWidth>
                        <InputGroup.Input inputMode="numeric" placeholder="30" />
                      </InputGroup>
                      <Description>范围 1-120 分钟。</Description>
                    </TextField>
                  </div>
                )}
              </Fieldset.Group>
            </Fieldset>
          </Card.Content>
          <Card.Footer className="justify-end gap-3">
            <Button type="button" variant="outline" size="sm" onPress={detectAgents} isDisabled={detecting || saving}>
              {detecting ? <Spinner size="sm" /> : <ArrowsRotateLeft width={16} height={16} />}
              {detecting ? '探测中...' : '自动探测'}
            </Button>
            <Button type="submit" variant="primary" size="sm" isDisabled={saving || detecting}>
              {saving ? <Spinner size="sm" /> : <CircleCheck width={16} height={16} />}
              {saving ? '保存中...' : '保存配置'}
            </Button>
          </Card.Footer>
        </Form>
      </Card>

      <aside className="space-y-4">
        <Card>
          <Card.Header>
            <Card.Title className="text-base">当前状态</Card.Title>
            <Card.Description>{config.enabled ? 'Agent 页可使用本地模式' : '尚未启用本地模式'}</Card.Description>
          </Card.Header>
          <Card.Content>
            <dl className="space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">默认智能体</dt>
                <dd className="truncate font-medium text-foreground">{activeAgentLabel}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="shrink-0 text-muted">命令</dt>
                <dd className="min-w-0 truncate text-right font-medium text-foreground">{activeAgent?.executablePath || 'PATH 自动查找'}</dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted">模型</dt>
                <dd className="truncate font-medium text-foreground">{activeAgent?.model || 'CLI 默认'}</dd>
              </div>
            </dl>
          </Card.Content>
        </Card>

        {error ? (
          <Alert status="danger">
            <Alert.Content>
              <Alert.Title>配置失败</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : (
          <Alert status="default">
            <Alert.Content>
              <Alert.Title>运行方式</Alert.Title>
              <Alert.Description>本地智能体在代码工作区副本中生成补丁，确认后才应用到真实项目。</Alert.Description>
            </Alert.Content>
          </Alert>
        )}

        {detectResults.length > 0 && (
          <Card>
            <Card.Header>
              <Card.Title className="text-base">探测结果</Card.Title>
            </Card.Header>
            <Card.Content className="grid gap-2">
              {detectResults.map((item) => (
                <div className="flex min-w-0 items-center gap-2 text-xs" key={item.id}>
                  <span className={`size-1.5 shrink-0 rounded-full ${detectionStatusClass(item)}`} />
                  <span className="shrink-0 text-foreground">{item.name}</span>
                  <span className="min-w-0 truncate text-muted-foreground">{item.found ? item.executablePath : item.error}</span>
                  {item.found ? <CircleCheck className="size-3 shrink-0 text-emerald-500" /> : <Xmark className="size-3 shrink-0 text-amber-500" />}
                </div>
              ))}
            </Card.Content>
          </Card>
        )}

        <Typography.Paragraph size="xs" color="muted">
          注意：这里复用你本机 CLI 已登录的账号或订阅，不会把这些订阅转换成云端 API Key。
        </Typography.Paragraph>
      </aside>
    </div>
  )
}
