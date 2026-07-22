/**
 * 嵌入模型设置（语义/向量检索用，独立于聊天模型）。
 * 只保留必要项：接口 URL、API Key、模型、向量维度 + 启用开关 + 测试/保存。
 * 协议固定 openai-compatible（对 OpenAI 官方也通），不再做服务商下拉。
 * 自带 IPC（embedding:getConfig/setConfig/test）。
 */
import { useEffect, useState } from 'react'
import { Button, Card, Description, InputGroup, Label, ListBox, Select, Switch, TextField } from '@heroui/react'
import { ArrowUpRightFromSquare, CircleCheck, CircleExclamation, Picture, PlugConnection } from '@gravity-ui/icons'
import type { EmbeddingConfig } from '@/types/electron'

const SILICONFLOW_REFERRAL_URL = 'https://cloud.siliconflow.cn/i/lNl8YK1m'

const DEFAULT_CFG: EmbeddingConfig = {
  enabled: false,
  provider: '',
  protocol: 'openai-compatible',
  apiKey: '',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-m3',
  dimension: 0,
  imageEnabled: false,
  imageInputMode: 'auto',
}

const IMAGE_INPUT_MODE_OPTIONS: Array<{ id: NonNullable<EmbeddingConfig['imageInputMode']>; label: string; description: string }> = [
  { id: 'auto', label: '自动', description: '先试图片对象 base64，再试 content-part / data-url' },
  { id: 'image_base64', label: 'Base64 图片对象', description: 'input 使用 { image: "纯 base64" }，硅基 VL Embedding 推荐' },
  { id: 'content_part', label: 'Content Part', description: 'input 使用 image_url 内容块' },
  { id: 'data_url', label: 'Data URL', description: 'input 直接传图片 data URL' },
]

function imageInputModeLabel(mode: EmbeddingConfig['imageInputMode']): string {
  return IMAGE_INPUT_MODE_OPTIONS.find((item) => item.id === (mode || 'auto'))?.label || '自动'
}

export default function EmbeddingTab() {
  const [cfg, setCfg] = useState<EmbeddingConfig>(DEFAULT_CFG)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.electronAPI.embedding.getConfig().then((res) => {
      if (res.success && res.config) setCfg({ ...DEFAULT_CFG, ...res.config, protocol: 'openai-compatible' })
      setLoaded(true)
    })
  }, [])

  const patch = (p: Partial<EmbeddingConfig>) => setCfg((c) => ({ ...c, ...p }))

  const handleOpenSiliconFlowReferral = () => {
    void window.electronAPI.shell.openExternal(SILICONFLOW_REFERRAL_URL)
  }

  const handleTest = async () => {
    setTesting(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.embedding.test(cfg)
      if (res.success) {
        const imageText = cfg.imageEnabled && res.imageDimension
          ? `；图片向量 ${res.imageDimension} 维，模式 ${res.imageInputMode || cfg.imageInputMode || 'auto'}`
          : ''
        setStatus({
          ok: true,
          text: `${res.dimensionMismatch || (cfg.dimension > 0
            ? `连接成功，探测到模型维度 ${res.dimension}`
            : `连接成功，模型默认维度 ${res.dimension}（如需固定维度，在上方"向量维度"填写）`)}${imageText}`,
        })
      } else {
        setStatus({ ok: false, text: res.error || '测试失败' })
      }
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.embedding.setConfig(cfg)
      setStatus(res.success ? { ok: true, text: '已保存' } : { ok: false, text: res.error || '保存失败' })
    } finally {
      setSaving(false)
    }
  }

  if (!loaded) return null

  return (
    <Card>
      <Card.Header className="flex-row items-start justify-between gap-3">
        <div>
          <Card.Title>语义检索（嵌入模型）</Card.Title>
          <Card.Description>
            供 AI 助手做语义/向量检索，独立于聊天模型。需 OpenAI 兼容的嵌入接口（如硅基流动 bge-m3、通义、智谱、OpenAI）。
          </Card.Description>
          <Button className="mt-3" onPress={handleOpenSiliconFlowReferral} size="sm" type="button" variant="outline">
            <ArrowUpRightFromSquare width={14} height={14} />
            推荐：硅基流动
          </Button>
        </div>
        <Switch
          aria-label={cfg.enabled ? '关闭语义检索嵌入模型' : '启用语义检索嵌入模型'}
          isSelected={cfg.enabled}
          onChange={(v) => patch({ enabled: v })}
        >
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch>
      </Card.Header>
      <Card.Content className="space-y-5">
        <TextField fullWidth onChange={(v) => patch({ baseURL: v })} value={cfg.baseURL}>
          <Label>接口 URL（baseURL）</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="https://api.siliconflow.cn/v1" />
          </InputGroup>
          <Description>填 /v1 基地址即可，会自动拼 /embeddings。</Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ apiKey: v })} value={cfg.apiKey}>
          <Label>API Key</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="请输入嵌入服务 API Key" type="password" />
          </InputGroup>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ model: v })} value={cfg.model}>
          <Label>嵌入模型</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="BAAI/bge-m3" />
          </InputGroup>
          <Description>嵌入型号需手填（不在聊天模型列表里）。</Description>
        </TextField>

        <TextField
          fullWidth
          onChange={(v) => patch({ dimension: Math.max(0, Math.floor(Number(v) || 0)) })}
          value={cfg.dimension ? String(cfg.dimension) : ''}
        >
          <Label>向量维度</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="留空 = 自动（用模型默认维度）" inputMode="numeric" />
          </InputGroup>
          <Description>
            留空/0 = 自动；填具体值则要求接口按该维度输出（需模型支持，如 text-embedding-3 / Qwen3-embedding；bge-m3 等固定维度的填默认值或留空）。
          </Description>
        </TextField>

        <div className="rounded-md border border-border/70 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-1">
              <Label className="flex items-center gap-2">
                <Picture width={16} height={16} />
                图片向量化
              </Label>
              <Description>
                开启后，允许手动建立历史图片向量；Agent 找图时只搜索已经建立好的图片向量，不会临时上传历史图片做向量化。
              </Description>
            </div>
            <Switch
              aria-label={cfg.imageEnabled ? '关闭图片向量化' : '启用图片向量化'}
              isSelected={cfg.imageEnabled === true}
              onChange={(v) => patch({ imageEnabled: v })}
            >
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
            </Switch>
          </div>

          <Select
            className="mt-4 w-full"
            isDisabled={!cfg.imageEnabled}
            selectedKey={cfg.imageInputMode || 'auto'}
            onSelectionChange={(key) => {
              const next = String(key || 'auto') as NonNullable<EmbeddingConfig['imageInputMode']>
              patch({ imageInputMode: next })
            }}
            variant="secondary"
          >
            <Label>图片输入格式</Label>
            <Select.Trigger>
              <Select.Value>{() => imageInputModeLabel(cfg.imageInputMode)}</Select.Value>
              <Select.Indicator />
            </Select.Trigger>
            <Select.Popover>
              <ListBox>
                {IMAGE_INPUT_MODE_OPTIONS.map((option) => (
                  <ListBox.Item key={option.id} id={option.id} textValue={option.label}>
                    <div className="flex flex-col">
                      <span>{option.label}</span>
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    </div>
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                ))}
              </ListBox>
            </Select.Popover>
            <Description>不确定模型格式时选自动。</Description>
          </Select>
        </div>

        {status && (
          <p className={`flex items-center gap-1.5 text-sm ${status.ok ? 'text-green-600' : 'text-red-600'}`}>
            {status.ok ? <CircleCheck width={16} height={16} /> : <CircleExclamation width={16} height={16} />}
            {status.text}
          </p>
        )}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Button isDisabled={testing || !cfg.apiKey || !cfg.model} onPress={() => void handleTest()} type="button" variant="outline">
          <PlugConnection width={16} height={16} />
          {testing ? '测试中…' : '测试连接'}
        </Button>
        <Button isDisabled={saving} onPress={() => void handleSave()} type="button" variant="primary">
          {saving ? '保存中…' : '保存'}
        </Button>
      </Card.Footer>
    </Card>
  )
}
