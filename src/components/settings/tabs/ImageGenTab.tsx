/**
 * AI 作图设置 —— AI 助手的 generate_image 工具。
 * 启用并配好后，在 AI 助手里说"帮我画一张…"即可生成图片并展示在对话流里。
 * 自带 IPC（imageGen:getConfig/setConfig/test）。
 */
import { useEffect, useState } from 'react'
import { Button, Card, Description, InputGroup, Label, ListBox, Select, Switch, TextField } from '@heroui/react'
import { CircleCheck, CircleExclamation, Picture } from '@gravity-ui/icons'
import type { ImageGenConfig } from '@/types/electron'

const DEFAULT_CFG: ImageGenConfig = {
  enabled: false,
  protocol: 'openai-compatible',
  apiKey: '',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'Kwai-Kolors/Kolors',
  size: '',
  timeoutMs: 3_600_000,
}

const PROTOCOL_OPTIONS: Array<{ value: ImageGenConfig['protocol']; label: string; hint: string }> = [
  { value: 'openai-compatible', label: 'OpenAI 兼容', hint: '硅基流动、智谱等国内厂商的 /images/generations 接口' },
  { value: 'custom', label: '自定义完整地址', hint: '直接请求填写的完整 URL，不自动拼接 /images/generations' },
  { value: 'openai', label: 'OpenAI 官方', hint: 'gpt-image-1 / dall-e-3，走官方协议' },
  { value: 'google', label: 'Google Gemini', hint: 'Imagen 系列模型' },
]

export default function ImageGenTab() {
  const [cfg, setCfg] = useState<ImageGenConfig>(DEFAULT_CFG)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)
  const [previewPath, setPreviewPath] = useState('')

  useEffect(() => {
    void window.electronAPI.imageGen.getConfig().then((res) => {
      if (res.success && res.config) setCfg({ ...DEFAULT_CFG, ...res.config })
      setLoaded(true)
    })
  }, [])

  const patch = (p: Partial<ImageGenConfig>) => setCfg((c) => ({ ...c, ...p }))
  const protocolOption = PROTOCOL_OPTIONS.find((o) => o.value === cfg.protocol)
  const timeoutSeconds = Math.round((cfg.timeoutMs || DEFAULT_CFG.timeoutMs) / 1000)
  const customEndpoint = cfg.protocol === 'custom'

  const handleTest = async () => {
    setTesting(true)
    setStatus(null)
    setPreviewPath('')
    try {
      const res = await window.electronAPI.imageGen.test(cfg)
      if (res.success && res.filePath) {
        setPreviewPath(res.filePath)
        setStatus({ ok: true, text: '生成成功，配置可用' })
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
      const res = await window.electronAPI.imageGen.setConfig(cfg)
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
          <Card.Title>AI 作图</Card.Title>
          <Card.Description>
            启用后，在 AI 助手里说"帮我画一张…"即可调用作图模型生成图片，并直接展示在对话里。
            图片保存在缓存目录的 ai-images 文件夹。
          </Card.Description>
        </div>
        <Switch
          aria-label={cfg.enabled ? '关闭 AI 作图' : '启用 AI 作图'}
          isSelected={cfg.enabled}
          onChange={(v) => patch({ enabled: v })}
        >
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch>
      </Card.Header>
      <Card.Content className="space-y-5">
        <Select
          selectedKey={cfg.protocol}
          onSelectionChange={(key) => {
            if (key != null) patch({ protocol: String(key) as ImageGenConfig['protocol'] })
          }}
          placeholder="选择协议"
          variant="secondary"
          fullWidth
        >
          <Label>协议</Label>
          <Select.Trigger>
            <Select.Value>{({ defaultChildren }) => protocolOption?.label || defaultChildren}</Select.Value>
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {PROTOCOL_OPTIONS.map((option) => (
                <ListBox.Item key={option.value} id={option.value} textValue={option.label}>
                  {option.label}
                  <ListBox.ItemIndicator />
                </ListBox.Item>
              ))}
            </ListBox>
          </Select.Popover>
          <Description>{protocolOption?.hint}</Description>
        </Select>

        <TextField fullWidth onChange={(v) => patch({ apiKey: v })} value={cfg.apiKey}>
          <Label>API Key</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="sk-..." type="password" />
          </InputGroup>
          <Description>服务商控制台获取，仅保存在本地。</Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ baseURL: v })} value={cfg.baseURL}>
          <Label>{customEndpoint ? '完整接口地址' : '接口地址'}</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder={customEndpoint ? 'https://api.example.com/v1/images/generations' : 'https://api.siliconflow.cn/v1'} />
          </InputGroup>
          <Description>
            {customEndpoint
              ? '自定义完整地址会直接请求此 URL；请求体仍使用 OpenAI 图片生成格式。'
              : 'OpenAI 官方/Google 可留空用默认地址；OpenAI 兼容厂商必填 /v1 地址。'}
          </Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ model: v })} value={cfg.model}>
          <Label>模型</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="Kwai-Kolors/Kolors" />
          </InputGroup>
          <Description>如硅基流动 Kwai-Kolors/Kolors、OpenAI gpt-image-1、智谱 cogview-4。</Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ size: v.trim() })} value={cfg.size}>
          <Label>图片尺寸</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="留空由 AI 自选" />
          </InputGroup>
          <Description>
            格式 宽x高（如 1024x1024）。留空时由 AI 按画面选横/竖/方图；填了则作为 AI 未指定尺寸时的默认值。
          </Description>
        </TextField>

        <TextField
          fullWidth
          onChange={(v) => {
            const seconds = Math.max(60, Math.min(3600, Math.floor(Number(v) || 3600)))
            patch({ timeoutMs: seconds * 1000 })
          }}
          type="number"
          value={String(timeoutSeconds)}
        >
          <Label>超时时间</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input max="3600" min="60" step="30" type="number" />
            <InputGroup.Suffix>秒</InputGroup.Suffix>
          </InputGroup>
          <Description>默认 3600 秒（1 小时），可设置 60 到 3600 秒；慢速作图模型建议保持默认值。</Description>
        </TextField>

        {status && (
          <p className={`flex items-center gap-1.5 text-sm ${status.ok ? 'text-green-600' : 'text-red-600'}`}>
            {status.ok ? <CircleCheck width={16} height={16} /> : <CircleExclamation width={16} height={16} />}
            {status.text}
          </p>
        )}

        {previewPath && (
          <button
            className="block w-fit cursor-zoom-in border-0 bg-transparent p-0"
            onClick={() => { void window.electronAPI.window.openImageViewerWindow(previewPath) }}
            title="点击预览"
            type="button"
          >
            <img
              alt="测试生成的图片"
              className="max-h-60 rounded-xl border border-border/60"
              src={`local-image://${encodeURIComponent(previewPath)}`}
            />
          </button>
        )}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Button isDisabled={testing || !cfg.apiKey || !cfg.model} onPress={() => void handleTest()} type="button" variant="outline">
          <Picture width={16} height={16} />
          {testing ? '生成中…' : '测试生成（消耗少量额度）'}
        </Button>
        <Button isDisabled={saving} onPress={() => void handleSave()} type="button" variant="primary">
          {saving ? '保存中…' : '保存'}
        </Button>
      </Card.Footer>
    </Card>
  )
}
