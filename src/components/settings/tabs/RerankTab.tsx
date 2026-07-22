/**
 * 重排模型设置（RAG/Skills/MCP 候选排序用，独立于聊天模型与嵌入模型）。
 */
import { useEffect, useState } from 'react'
import { Button, Card, Description, InputGroup, Label, Switch, TextField } from '@heroui/react'
import { CircleCheck, CircleExclamation, PlugConnection } from '@gravity-ui/icons'
import type { RerankConfig } from '@/types/electron'

const DEFAULT_CFG: RerankConfig = {
  enabled: false,
  provider: '',
  protocol: 'openai-compatible',
  apiKey: '',
  baseURL: 'https://api.siliconflow.cn/v1',
  model: 'BAAI/bge-reranker-v2-m3',
  timeoutMs: 15000,
}

export default function RerankTab() {
  const [cfg, setCfg] = useState<RerankConfig>(DEFAULT_CFG)
  const [loaded, setLoaded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    void window.electronAPI.rerank.getConfig().then((res) => {
      if (res.success && res.config) setCfg({ ...DEFAULT_CFG, ...res.config, protocol: 'openai-compatible' })
      setLoaded(true)
    })
  }, [])

  const patch = (p: Partial<RerankConfig>) => setCfg((c) => ({ ...c, ...p, protocol: 'openai-compatible' }))

  const handleTest = async () => {
    setTesting(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.rerank.test({ ...cfg, protocol: 'openai-compatible' })
      setStatus(res.success ? { ok: true, text: '连接成功，重排结果有效' } : { ok: false, text: res.error || '测试失败' })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setStatus(null)
    try {
      const res = await window.electronAPI.rerank.setConfig({ ...cfg, protocol: 'openai-compatible' })
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
          <Card.Title>候选重排（Rerank 模型）</Card.Title>
          <Card.Description>
            供 AI 助手重排 Skills、外部 MCP 工具、聊天检索结果和长期记忆召回，独立于聊天模型。
          </Card.Description>
        </div>
        <Switch
          aria-label={cfg.enabled ? '关闭候选重排模型' : '启用候选重排模型'}
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
          <Description>填 /v1 基地址即可，会自动拼 /rerank。</Description>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ apiKey: v })} value={cfg.apiKey}>
          <Label>API Key</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="请输入重排服务 API Key" type="password" />
          </InputGroup>
        </TextField>

        <TextField fullWidth onChange={(v) => patch({ model: v })} value={cfg.model}>
          <Label>重排模型</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="BAAI/bge-reranker-v2-m3" />
          </InputGroup>
          <Description>模型名需手填，接口需兼容 OpenAI 风格 rerank 请求。</Description>
        </TextField>

        <TextField
          fullWidth
          onChange={(v) => patch({ timeoutMs: Math.max(3000, Math.floor(Number(v) || DEFAULT_CFG.timeoutMs)) })}
          value={String(cfg.timeoutMs || DEFAULT_CFG.timeoutMs)}
        >
          <Label>请求超时（毫秒）</Label>
          <InputGroup fullWidth variant="secondary">
            <InputGroup.Input placeholder="15000" inputMode="numeric" />
          </InputGroup>
          <Description>重排失败会自动回退原排序，不影响 AI 助手回答。</Description>
        </TextField>

        {status && (
          <p className={`flex items-center gap-1.5 text-sm ${status.ok ? 'text-green-600' : 'text-red-600'}`}>
            {status.ok ? <CircleCheck width={16} height={16} /> : <CircleExclamation width={16} height={16} />}
            {status.text}
          </p>
        )}
      </Card.Content>
      <Card.Footer className="flex flex-wrap gap-2">
        <Button isDisabled={testing || !cfg.apiKey || !cfg.baseURL || !cfg.model} onPress={() => void handleTest()} type="button" variant="outline">
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
