import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  AlertDialog,
  Button,
  ButtonGroup,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  ScrollShadow,
  Select,
  Separator,
  Spinner,
  Surface,
  Switch,
  Tabs,
  TextArea,
  TextField,
  Tooltip,
  toast,
  Typography,
} from '@heroui/react'
import JSZip from 'jszip'
import { ArrowDownToLine, ArrowUpToLine, Copy, Eye, FileCode, FloppyDisk, Pencil, PlugConnection, PlugWire, Plus, TrashBin, Xmark } from '@gravity-ui/icons'
import * as configService from '../services/config'

type McpLaunchConfig = {
  command: string
  args: string[]
  cwd: string
  mode: 'dev' | 'packaged'
}

type SkillInfo = { name: string; version: string; description: string; builtin: boolean }

type McpClientConfig = {
  type: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  timeoutMs?: number
  autoConnect?: boolean
}

type McpServerStatus = {
  name: string
  config: McpClientConfig
  status: string
  toolCount: number
  error?: string
}

type McpToolInfo = {
  name: string
  description?: string
  inputSchema?: unknown
}

type TopTab = 'mcp' | 'skills'

type ServerFormState = {
  name: string
  type: string
  command: string
  args: string
  env: string
  cwd: string
  url: string
  headers: string
  timeoutMs: string
}

type SkillPanelState = {
  name: string
  mode: 'preview' | 'edit'
}

type SkillDialogState = SkillPanelState | null

function createEmptyServerForm(): ServerFormState {
  return {
    name: '',
    type: 'stdio',
    command: '',
    args: '',
    env: '',
    cwd: '',
    url: '',
    headers: '',
    timeoutMs: '30000',
  }
}

type ParsedServerResult = { name?: string; form: Partial<ServerFormState>; error?: string }

function configObjectToForm(cfg: Record<string, unknown>): Partial<ServerFormState> {
  const form: Partial<ServerFormState> = {}
  if (typeof cfg.url === 'string' && cfg.url) {
    form.type = cfg.url.endsWith('/sse') ? 'sse' : 'http'
    form.url = cfg.url
    if (cfg.headers && typeof cfg.headers === 'object' && !Array.isArray(cfg.headers)) {
      form.headers = Object.entries(cfg.headers as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('\n')
    }
  } else if (typeof cfg.command === 'string' && cfg.command) {
    form.type = 'stdio'
    form.command = cfg.command
    if (Array.isArray(cfg.args)) {
      form.args = (cfg.args as unknown[]).map(a => {
        const s = String(a)
        return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
      }).join(' ')
    }
    if (typeof cfg.cwd === 'string') form.cwd = cfg.cwd
    if (cfg.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)) {
      form.env = Object.entries(cfg.env as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('\n')
    }
  }
  if (typeof cfg.timeout === 'number') form.timeoutMs = String(cfg.timeout)
  return form
}

function parseServerJson(text: string): ParsedServerResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return { form: {}, error: 'JSON 格式错误，请检查括号和引号是否匹配' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { form: {}, error: '请粘贴对象格式的 JSON' }
  }
  const obj = parsed as Record<string, unknown>

  if (obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)) {
    const entries = Object.entries(obj.mcpServers as Record<string, unknown>)
    if (entries.length === 0) return { form: {}, error: 'mcpServers 中没有服务器' }
    const [name, cfg] = entries[0]
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return { form: {}, error: '服务器配置格式不正确' }
    return { name, form: configObjectToForm(cfg as Record<string, unknown>) }
  }

  if (obj.command || obj.url) {
    return { form: configObjectToForm(obj) }
  }

  const entries = Object.entries(obj)
  if (entries.length > 0) {
    const [name, cfg] = entries[0]
    if (cfg && typeof cfg === 'object' && !Array.isArray(cfg)) {
      const cfgObj = cfg as Record<string, unknown>
      if (cfgObj.command || cfgObj.url) {
        return { name, form: configObjectToForm(cfgObj) }
      }
    }
  }

  return { form: {}, error: '无法识别格式，支持：完整 mcpServers 包裹 / 单条服务器对象 / 直接 command/url 配置' }
}

function stringifyKeyValueLines(value?: Record<string, string>) {
  if (!value) return ''
  return Object.entries(value).map(([key, val]) => `${key}=${val}`).join('\n')
}

function parseKeyValueLines(value: string): Record<string, string> | undefined {
  const entries = value
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const separator = line.indexOf('=')
      if (separator < 0) return null
      const key = line.slice(0, separator).trim()
      const val = line.slice(separator + 1).trim()
      return key ? [key, val] as const : null
    })
    .filter((entry): entry is readonly [string, string] => Boolean(entry))
  return entries.length ? Object.fromEntries(entries) : undefined
}

function parseArgs(value: string): string[] | undefined {
  const trimmed = value.trim()
  if (!trimmed) return undefined
  const parts = trimmed.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  return parts.map(part => part.replace(/^["']|["']$/g, '')).filter(Boolean)
}

function McpPage() {
  const [topTab, setTopTab] = useState<TopTab>('mcp')

  const [mcpEnabled, setMcpEnabled] = useState(false)
  const [mcpExposeMediaPaths, setMcpExposeMediaPaths] = useState(true)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [exportingSkillZip, setExportingSkillZip] = useState<string | null>(null)
  const [launchConfig, setLaunchConfig] = useState<McpLaunchConfig>({
    command: 'npm', args: ['run', 'mcp'], cwd: 'D:/CipherTalk', mode: 'dev',
  })

  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [mcpServers, setMcpServers] = useState<McpServerStatus[]>([])

  const [skillDialog, setSkillDialog] = useState<SkillDialogState>(null)
  const [editingSkillContent, setEditingSkillContent] = useState('')
  const [serverPanelOpen, setServerPanelOpen] = useState(false)
  const [editingServer, setEditingServer] = useState<string | null>(null)
  const [serverForm, setServerForm] = useState<ServerFormState>(createEmptyServerForm)
  const [serverBusy, setServerBusy] = useState<Record<string, 'connect' | 'disconnect' | 'tools'>>({})
  const [toolDialogServer, setToolDialogServer] = useState<string | null>(null)
  const [serverTools, setServerTools] = useState<Record<string, McpToolInfo[]>>({})
  const [serverFormMode, setServerFormMode] = useState<'fields' | 'json'>('fields')
  const [jsonPasteText, setJsonPasteText] = useState('')
  const [jsonPasteError, setJsonPasteError] = useState<string | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const [enabled, exposeMediaPaths, skillList] = await Promise.all([
          configService.getMcpEnabled(),
          configService.getMcpExposeMediaPaths(),
          window.electronAPI.skillManager.list(),
        ])
        setMcpEnabled(enabled)
        setMcpExposeMediaPaths(exposeMediaPaths)
        setSkills(skillList)
        try {
          const cfg = await window.electronAPI.app.getMcpLaunchConfig()
          if (cfg?.command && Array.isArray(cfg.args) && cfg.cwd) setLaunchConfig(cfg)
        } catch (inner) {
          if (!String(inner || '').includes("No handler registered for 'app:getMcpLaunchConfig'"))
            console.error('获取 MCP 启动配置失败:', inner)
        }
      } catch (e) {
        console.error('加载 MCP 配置失败:', e)
        toast.danger('加载 MCP 配置失败')
      } finally {
        setLoading(false)
      }
    }
    void load()
  }, [])

  const loadIntegrationData = useCallback(async () => {
    try {
      const [skillList, serverList] = await Promise.all([
        window.electronAPI.skillManager.list(),
        window.electronAPI.mcpClient.listStatuses(),
      ])
      setSkills(skillList)
      setMcpServers(serverList)
    } catch (e) {
      console.error('加载集成数据失败:', e)
    }
  }, [])

  useEffect(() => {
    void loadIntegrationData()
  }, [topTab, loadIntegrationData])

  const mcpServerJsonTemplate = useMemo(() => JSON.stringify({
    mcpServers: { ciphertalk: { command: launchConfig.command, args: launchConfig.args, cwd: launchConfig.cwd } },
  }, null, 2), [launchConfig])

  const handleSave = async () => {
    setSaving(true)
    try {
      await Promise.all([configService.setMcpEnabled(mcpEnabled), configService.setMcpExposeMediaPaths(mcpExposeMediaPaths)])
      toast.success('MCP 配置已保存')
    } catch { toast.danger('保存 MCP 配置失败') }
    finally { setSaving(false) }
  }

  const copyText = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); toast.success(`${label}已复制`) }
    catch { toast.danger('复制失败，请手动复制') }
  }

  const exportSkillZip = async (skillName: string) => {
    setExportingSkillZip(skillName)
    try {
      const result = await window.electronAPI.skillManager.exportZip(skillName)
      toast[result.success ? 'success' : 'danger'](
        result.success ? `Skill 已导出到 ${result.outputPath}` : (result.error || '导出失败')
      )
    } catch { toast.danger('导出失败') }
    finally { setExportingSkillZip(null) }
  }

  const openSkillPanel = async (name: string, mode: 'preview' | 'edit') => {
    if (mode === 'preview') {
      try {
        await window.electronAPI.window.openSkillPreviewWindow(name)
      } catch {
        toast.danger('打开 Skill 预览窗口失败')
      }
      return
    }

    const result = await window.electronAPI.skillManager.readContent(name)
    if (result.success) {
      setEditingSkillContent(result.content || '')
      setSkillDialog({ name, mode })
    } else toast.danger(result.error || '读取失败')
  }

  const saveEditSkill = async () => {
    if (!skillDialog?.name) return
    const result = await window.electronAPI.skillManager.updateContent(skillDialog.name, editingSkillContent)
    toast[result.success ? 'success' : 'danger'](result.success ? 'Skill 已保存' : (result.error || '保存失败'))
    if (result.success) {
      setSkillDialog(null)
      void loadIntegrationData()
    }
  }

  const deleteSkill = async (name: string) => {
    const result = await window.electronAPI.skillManager.delete(name)
    toast[result.success ? 'success' : 'danger'](result.success ? `Skill "${name}" 已删除` : (result.error || '删除失败'))
    if (result.success) void loadIntegrationData()
  }

  const importSkill = async () => {
    try {
      const { canceled, filePaths } = await window.electronAPI.dialog.openFile({
        title: '导入 Skill 压缩包',
        filters: [{ name: 'Zip', extensions: ['zip'] }],
        properties: ['openFile'],
      })
      if (canceled || !filePaths?.[0]) return
      const result = await window.electronAPI.skillManager.importZip(filePaths[0])
      toast[result.success ? 'success' : 'danger'](
        result.success ? `Skill "${result.skillName}" 已导入` : (result.error || '导入失败')
      )
      if (result.success) void loadIntegrationData()
    } catch { toast.danger('导入失败') }
  }

  const downloadSkillTemplate = async () => {
    try {
      const zip = new JSZip()
      const root = zip.folder('ciphertalk-skill-template')
      root?.file('SKILL.md', `---\nname: ciphertalk-example\nversion: '1.0.0'\ndescription: Describe what this skill helps with.\n---\n\n# CipherTalk Example Skill\n\n## When to use\nUse this skill when...\n\n## Workflow\n1. Read the user request.\n2. Use the relevant CipherTalk context.\n3. Return a concise answer.\n`)
      root?.folder('references')?.file('README.md', '# References\n\nPut supporting docs here when the skill needs them.\n')
      const blob = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'ciphertalk-skill-template.zip'
      document.body.appendChild(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(url)
      toast.success('Skill 导入模板已生成')
    } catch { toast.danger('模板生成失败') }
  }

  const connectServer = async (name: string) => {
    if (serverBusy[name]) return
    setServerBusy(prev => ({ ...prev, [name]: 'connect' }))
    try {
      const result = await window.electronAPI.mcpClient.connect(name)
      if (result.success && result.tools) setServerTools(prev => ({ ...prev, [name]: result.tools || [] }))
      toast[result.success ? 'success' : 'danger'](
        result.success ? `已连接到 "${name}"，发现 ${result.tools?.length ?? 0} 个工具` : (result.error || '连接失败')
      )
      void loadIntegrationData()
    } finally {
      setServerBusy(prev => { const n = { ...prev }; delete n[name]; return n })
    }
  }

  const disconnectServer = async (name: string) => {
    if (serverBusy[name]) return
    setServerBusy(prev => ({ ...prev, [name]: 'disconnect' }))
    try {
      const result = await window.electronAPI.mcpClient.disconnect(name)
      if (result.success) setToolDialogServer(current => current === name ? null : current)
      toast[result.success ? 'success' : 'danger'](result.success ? `已断开 "${name}"` : (result.error || '断开失败'))
      void loadIntegrationData()
    } finally {
      setServerBusy(prev => { const n = { ...prev }; delete n[name]; return n })
    }
  }

  const openToolsDialog = async (name: string) => {
    setToolDialogServer(name)
    if (serverTools[name] || serverBusy[name]) return
    setServerBusy(prev => ({ ...prev, [name]: 'tools' }))
    try {
      const result = await window.electronAPI.mcpClient.listTools(name)
      if (result.success) setServerTools(prev => ({ ...prev, [name]: result.tools || [] }))
      else toast.danger(result.error || '工具加载失败')
    } finally {
      setServerBusy(prev => { const n = { ...prev }; delete n[name]; return n })
    }
  }

  const resetJsonPasteState = () => {
    setServerFormMode('fields')
    setJsonPasteText('')
    setJsonPasteError(null)
  }

  const applyJsonPaste = () => {
    const result = parseServerJson(jsonPasteText)
    if (result.error) { setJsonPasteError(result.error); return }
    setJsonPasteError(null)
    setServerForm(prev => ({
      ...createEmptyServerForm(),
      ...prev,
      ...(result.name && !editingServer ? { name: result.name } : {}),
      ...result.form,
    }))
    setServerFormMode('fields')
  }

  const openAddServer = () => {
    if (serverPanelOpen && !editingServer) { setServerPanelOpen(false); resetJsonPasteState(); return }
    setEditingServer(null)
    setServerForm(createEmptyServerForm())
    resetJsonPasteState()
    setServerPanelOpen(true)
  }

  const openEditServer = (srv: McpServerStatus) => {
    if (serverPanelOpen && editingServer === srv.name) {
      setServerPanelOpen(false); setEditingServer(null); setServerForm(createEmptyServerForm()); resetJsonPasteState()
      return
    }
    setServerPanelOpen(true)
    setEditingServer(srv.name)
    setServerForm({
      name: srv.name,
      type: srv.config.type,
      command: srv.config.command || '',
      args: srv.config.args?.join(' ') || '',
      env: stringifyKeyValueLines(srv.config.env),
      cwd: srv.config.cwd || '',
      url: srv.config.url || '',
      headers: stringifyKeyValueLines(srv.config.headers),
      timeoutMs: String(srv.config.timeoutMs || 30000),
    })
  }

  const saveServer = async () => {
    const name = serverForm.name.trim()
    if (!name) { toast.danger('请输入服务器名称'); return }
    if (!editingServer && mcpServers.some(s => s.name === name)) { toast.danger(`服务器 "${name}" 已存在，请换一个名称`); return }
    const timeoutMs = Number(serverForm.timeoutMs)
    if (serverForm.timeoutMs.trim() && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) { toast.danger('超时时间必须是正整数毫秒'); return }
    const config: McpClientConfig = { type: serverForm.type }
    if (serverForm.type === 'stdio') {
      if (!serverForm.command.trim()) { toast.danger('请输入启动命令'); return }
      config.command = serverForm.command.trim()
      config.args = parseArgs(serverForm.args)
      config.env = parseKeyValueLines(serverForm.env)
      config.cwd = serverForm.cwd.trim() || undefined
    } else {
      if (!serverForm.url.trim()) { toast.danger('请输入服务器 URL'); return }
      config.url = serverForm.url.trim()
      config.headers = parseKeyValueLines(serverForm.headers)
    }
    config.timeoutMs = serverForm.timeoutMs.trim() ? Math.round(timeoutMs) : undefined
    const result = await window.electronAPI.mcpClient.saveConfig(name, config, Boolean(editingServer))
    toast[result.success ? 'success' : 'danger'](result.success ? `服务器 "${name}" 已保存` : (result.error || '保存失败'))
    if (result.success) {
      setEditingServer(null); setServerPanelOpen(false); setServerForm(createEmptyServerForm())
      void loadIntegrationData()
    }
  }

  const deleteServer = async (name: string) => {
    const result = await window.electronAPI.mcpClient.deleteConfig(name)
    toast[result.success ? 'success' : 'danger'](result.success ? `服务器 "${name}" 已删除` : (result.error || '删除失败'))
    if (result.success) void loadIntegrationData()
  }

  const renderStatusChip = (status: string) => {
    const map: Record<string, { label: string; color: 'success' | 'danger' | 'default' | 'warning' }> = {
      connected: { label: '已连接', color: 'success' },
      disconnected: { label: '未连接', color: 'default' },
      error: { label: '错误', color: 'danger' },
      connecting: { label: '连接中', color: 'warning' },
    }
    const info = map[status] || map.disconnected
    return <Chip color={info.color} variant="secondary" size="sm">{info.label}</Chip>
  }

  const closeServerPanel = () => {
    setServerPanelOpen(false); setEditingServer(null); setServerForm(createEmptyServerForm()); resetJsonPasteState()
  }

  const renderCloseFormButton = () => (
    <Tooltip delay={0}>
      <Button isIconOnly variant="tertiary" size="sm" onPress={closeServerPanel}>
        <Xmark width={16} height={16} />
      </Button>
      <Tooltip.Content>关闭表单</Tooltip.Content>
    </Tooltip>
  )

  const renderServerForm = () => (
    <Surface variant="secondary" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Typography type="h6">{editingServer ? `编辑服务器：${editingServer}` : '添加 MCP 服务器'}</Typography>
          <Description>参数会保存到本机 MCP 客户端配置中。</Description>
        </div>
        {renderCloseFormButton()}
      </div>
      <div className="flex flex-col gap-4">
        {!editingServer && (
          <ButtonGroup variant="tertiary" size="sm">
            <Button
              variant={serverFormMode === 'fields' ? 'primary' : 'tertiary'}
              onPress={() => setServerFormMode('fields')}
            >
              表单填写
            </Button>
            <Button
              variant={serverFormMode === 'json' ? 'primary' : 'tertiary'}
              onPress={() => setServerFormMode('json')}
            >
              <ButtonGroup.Separator />
              粘贴 JSON
            </Button>
          </ButtonGroup>
        )}

          {serverFormMode === 'json' ? (
            <div className="flex flex-col gap-3">
              <Description>
                粘贴来自 Claude Desktop、Cursor 等工具的 <Typography.Code>mcpServers</Typography.Code> 配置，系统会自动识别并填入表单。
              </Description>
              <TextArea
                value={jsonPasteText}
                onChange={(e) => { setJsonPasteText(e.target.value); setJsonPasteError(null) }}
                placeholder={'{\n  "mcpServers": {\n    "my-server": {\n      "command": "npx",\n      "args": ["-y", "some-mcp-server"]\n    }\n  }\n}'}
                className="min-h-50"
              >
                <Label>JSON 配置</Label>
                <Description>
                  {jsonPasteError || '支持：完整 mcpServers 对象 / 单条服务器对象 / 直接 command 或 url 配置'}
                </Description>
              </TextArea>
              {jsonPasteError && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Description>{jsonPasteError}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
              <ButtonGroup variant="tertiary">
                <Button onPress={closeServerPanel}>取消</Button>
                <ButtonGroup.Separator />
                <Button variant="primary" isDisabled={!jsonPasteText.trim()} onPress={applyJsonPaste}>解析并填入</Button>
              </ButtonGroup>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <TextField value={serverForm.name} onChange={(v) => setServerForm(f => ({ ...f, name: v }))}
                  isDisabled={!!editingServer} className="w-full">
                  <Label>服务器名称</Label>
                  <Input placeholder="my-mcp-server" />
                </TextField>

                <Select className="w-full" value={serverForm.type}
                  onChange={(v) => setServerForm(f => ({ ...f, type: String(v) }))}>
                  <Label>传输类型</Label>
                  <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="stdio" textValue="Stdio">Stdio<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="sse" textValue="SSE">SSE<ListBox.ItemIndicator /></ListBox.Item>
                      <ListBox.Item id="http" textValue="Streamable HTTP">Streamable HTTP<ListBox.ItemIndicator /></ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>

                <TextField value={serverForm.timeoutMs} onChange={(v) => setServerForm(f => ({ ...f, timeoutMs: v }))} className="w-full">
                  <Label>超时时间 (ms)</Label>
                  <Input type="number" placeholder="30000" />
                </TextField>
              </div>

              {serverForm.type === 'stdio' ? (
                <div className="flex flex-col gap-3">
                  <TextField value={serverForm.command} onChange={(v) => setServerForm(f => ({ ...f, command: v }))} className="w-full">
                    <Label>命令</Label>
                    <Input placeholder="npx、node、python、uvx ..." />
                  </TextField>
                  <TextField value={serverForm.args} onChange={(v) => setServerForm(f => ({ ...f, args: v }))} className="w-full">
                    <Label>参数</Label>
                    <Input placeholder="-y @modelcontextprotocol/server-filesystem D:/Workspace" />
                  </TextField>
                  <TextField value={serverForm.cwd} onChange={(v) => setServerForm(f => ({ ...f, cwd: v }))} className="w-full">
                    <Label>工作目录 (可选)</Label>
                    <Input placeholder="D:/Workspace/project" />
                  </TextField>
                  <TextArea value={serverForm.env}
                    onChange={(e) => setServerForm(f => ({ ...f, env: e.target.value }))}
                    placeholder={'API_KEY=...\nNODE_ENV=production'}
                    className="min-h-20">
                    <Label>环境变量</Label>
                    <Description>每行 KEY=VALUE。</Description>
                  </TextArea>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <TextField value={serverForm.url} onChange={(v) => setServerForm(f => ({ ...f, url: v }))} className="w-full">
                    <Label>URL</Label>
                    <Input placeholder={serverForm.type === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'} />
                  </TextField>
                  <TextArea value={serverForm.headers}
                    onChange={(e) => setServerForm(f => ({ ...f, headers: e.target.value }))}
                    placeholder={'Authorization=Bearer ...\nX-Api-Key=...'}
                    className="min-h-20">
                    <Label>请求头</Label>
                    <Description>每行 KEY=VALUE。</Description>
                  </TextArea>
                </div>
              )}

              <ButtonGroup variant="tertiary">
                <Button onPress={closeServerPanel}>取消</Button>
                <ButtonGroup.Separator />
                <Button variant="primary" onPress={saveServer}>保存</Button>
              </ButtonGroup>
            </>
          )}
      </div>
    </Surface>
  )

  const renderToolsContent = (serverName: string) => {
    const tools = serverTools[serverName] || []
    const loadingTools = serverBusy[serverName] === 'tools'
    return (
      <ScrollShadow hideScrollBar className="max-h-[68vh]" size={40}>
        <div className="flex flex-col gap-3">
          {loadingTools ? (
            <Alert status="default">
              <Alert.Indicator><Spinner size="sm" /></Alert.Indicator>
              <Alert.Content>
                <Alert.Description>正在读取工具列表...</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : tools.length === 0 ? (
            <Alert status="default">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Description>暂无工具或服务器尚未返回工具列表。</Alert.Description>
              </Alert.Content>
            </Alert>
          ) : (
            tools.map(tool => (
              <Surface key={tool.name} variant="transparent" className="flex flex-col gap-3">
                <div>
                  <Typography type="body-sm" weight="semibold">{tool.name}</Typography>
                  {tool.description && <Description>{tool.description}</Description>}
                </div>
                {tool.inputSchema !== undefined && tool.inputSchema !== null && (
                  <TextArea
                    readOnly
                    value={JSON.stringify(tool.inputSchema, null, 2)}
                    className="min-h-40"
                  >
                    <Label>输入 Schema</Label>
                  </TextArea>
                )}
              </Surface>
            ))
          )}
        </div>
      </ScrollShadow>
    )
  }

  const renderDeleteDialog = (type: 'skill' | 'server', name: string, isDisabled = false) => (
    <AlertDialog>
      <Button variant="danger" size="sm" isDisabled={isDisabled}>
        <TrashBin width={14} height={14} />
        删除
      </Button>
      <AlertDialog.Backdrop>
        <AlertDialog.Container size="sm">
          <AlertDialog.Dialog>
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="danger" />
              <AlertDialog.Heading>确认删除</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <Typography.Paragraph color="muted" size="sm">
                确定要删除{type === 'skill' ? ' Skill' : ' MCP 服务器'} "{name}" 吗？此操作不可撤销。
              </Typography.Paragraph>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button slot="close" variant="tertiary">取消</Button>
              <Button
                slot="close"
                variant="danger"
                onPress={() => {
                  if (type === 'skill') void deleteSkill(name)
                  else void deleteServer(name)
                }}
              >
                删除
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </AlertDialog>
  )

  const renderSkillRow = (skill: SkillInfo) => (
    <Surface key={skill.name} variant="transparent" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <FileCode width={18} height={18} />
          <Typography type="body-sm" weight="semibold" truncate>{skill.name}</Typography>
          <Chip variant="secondary" size="sm">v{skill.version}</Chip>
          {skill.builtin && <Chip color="accent" variant="primary" size="sm">内置</Chip>}
        </div>
        <Description>{skill.description}</Description>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="tertiary" size="sm" onPress={() => openSkillPanel(skill.name, 'preview')}>
          <Eye width={14} height={14} />
          预览
        </Button>
        {!skill.builtin && (
          <Button variant="tertiary" size="sm" onPress={() => openSkillPanel(skill.name, 'edit')}>
            <Pencil width={14} height={14} />
            编辑
          </Button>
        )}
        <Button
          variant="tertiary"
          size="sm"
          isDisabled={exportingSkillZip === skill.name}
          onPress={() => exportSkillZip(skill.name)}
        >
          <ArrowDownToLine width={14} height={14} />
          {exportingSkillZip === skill.name ? '导出中...' : '导出'}
        </Button>
        {!skill.builtin && renderDeleteDialog('skill', skill.name)}
      </div>
    </Surface>
  )

  const renderServerRow = (srv: McpServerStatus) => {
    const isBusy = Boolean(serverBusy[srv.name] || srv.status === 'connecting')
    const isActionBusy = Boolean(serverBusy[srv.name] && serverBusy[srv.name] !== 'tools')
    const endpoint = srv.config.type === 'stdio'
      ? `${srv.config.command} ${(srv.config.args || []).join(' ')}`
      : srv.config.url

    return (
      <div key={srv.name} className="flex flex-col gap-2">
        <Surface variant="transparent" className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <PlugConnection width={16} height={16} />
              <Typography type="body-sm" weight="semibold" truncate>{srv.name}</Typography>
              <Chip variant="secondary" size="sm">{srv.config.type.toUpperCase()}</Chip>
              {renderStatusChip(srv.status)}
              {srv.config.timeoutMs && <Chip variant="secondary" size="sm">{srv.config.timeoutMs}ms</Chip>}
            </div>
            <Description>{endpoint}</Description>
            {srv.error && (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Description>{srv.error}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}
          </div>
          <div className="flex items-center gap-2">
            {srv.status === 'connected' && (
              <Button
                variant="tertiary"
                size="sm"
                isDisabled={isActionBusy}
                onPress={() => openToolsDialog(srv.name)}
              >
                {serverBusy[srv.name] === 'tools' ? <Spinner size="sm" color="current" /> : null}
                预览工具 {srv.toolCount}
              </Button>
            )}
            {srv.status === 'connected' ? (
              <Tooltip delay={0}>
                <Button isIconOnly variant="tertiary" size="sm" isDisabled={Boolean(serverBusy[srv.name])} onPress={() => disconnectServer(srv.name)}>
                  {serverBusy[srv.name] === 'disconnect' ? <Spinner size="sm" color="current" /> : <PlugWire width={14} height={14} />}
                </Button>
                <Tooltip.Content>断开</Tooltip.Content>
              </Tooltip>
            ) : (
              <Tooltip delay={0}>
                <Button isIconOnly variant="tertiary" size="sm" isDisabled={isBusy} onPress={() => connectServer(srv.name)}>
                  {serverBusy[srv.name] === 'connect' || srv.status === 'connecting' ? <Spinner size="sm" color="current" /> : <PlugConnection width={14} height={14} />}
                </Button>
                <Tooltip.Content>连接</Tooltip.Content>
              </Tooltip>
            )}
            <Tooltip delay={0}>
              <Button isIconOnly variant="tertiary" size="sm" isDisabled={isBusy} onPress={() => openEditServer(srv)}>
                <Pencil width={14} height={14} />
              </Button>
              <Tooltip.Content>编辑</Tooltip.Content>
            </Tooltip>
            {renderDeleteDialog('server', srv.name, isBusy)}
          </div>
        </Surface>
        {serverPanelOpen && editingServer === srv.name && renderServerForm()}
      </div>
    )
  }

  return (
    <>
      <ScrollShadow hideScrollBar className="h-full min-h-0 pb-3" size={56}>
        <Tabs selectedKey={topTab} onSelectionChange={(key) => setTopTab(String(key) as TopTab)}>
          <Tabs.ListContainer>
            <Tabs.List aria-label="MCP 与 Skills 管理">
              <Tabs.Tab id="mcp">MCP<Tabs.Indicator /></Tabs.Tab>
              <Tabs.Tab id="skills">Skills<Tabs.Indicator /></Tabs.Tab>
            </Tabs.List>
          </Tabs.ListContainer>

          <Tabs.Panel id="mcp" className="pt-3">
            <div className="flex flex-col gap-3">
              <section className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <Typography type="h5">MCP 服务端</Typography>
                    <Description>CipherTalk 作为 MCP 服务端对外暴露工具。</Description>
                  </div>
                  <Tooltip delay={0}>
                    <Button variant="primary" isIconOnly isPending={saving} isDisabled={loading || saving} onPress={handleSave}>
                      <FloppyDisk width={16} height={16} />
                    </Button>
                    <Tooltip.Content>保存配置</Tooltip.Content>
                  </Tooltip>
                </div>
                <div className="flex flex-col gap-3">
                  <Surface variant="transparent" className="flex items-center justify-between gap-3">
                    <div>
                      <Typography type="body-sm" weight="semibold">MCP 状态标记</Typography>
                      <Description>在 health_check / get_status 中暴露配置状态，不阻止宿主调用工具。</Description>
                    </div>
                    <Switch isSelected={mcpEnabled} onChange={setMcpEnabled} isDisabled={loading || saving}>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                    </Switch>
                  </Surface>
                  <Surface variant="transparent" className="flex items-center justify-between gap-3">
                    <div>
                      <Typography type="body-sm" weight="semibold">默认解析媒体本地路径</Typography>
                      <Description>控制 get_messages / search_messages 等工具是否返回图片、视频、语音、文件本地路径。</Description>
                    </div>
                    <Switch isSelected={mcpExposeMediaPaths} onChange={setMcpExposeMediaPaths} isDisabled={loading || saving}>
                      <Switch.Control><Switch.Thumb /></Switch.Control>
                    </Switch>
                  </Surface>
                </div>
              </section>

              <Separator variant="tertiary" />

              <section className="flex flex-col gap-3">
                <div>
                  <Typography type="h5">接入配置</Typography>
                  <Description>复制 mcpServers 配置到外部 Agent。</Description>
                </div>
                <div className="flex flex-col gap-2">
                  <Label>mcpServers 配置</Label>
                  <ScrollShadow hideScrollBar className="w-full max-h-65" size={36}>
                    <TextArea
                      value={mcpServerJsonTemplate}
                      readOnly
                      fullWidth
                      rows={10}
                      className="w-full min-h-55"
                    />
                  </ScrollShadow>
                  <Description>
                    {launchConfig.mode === 'packaged'
                      ? 'Windows 下已自动通过 cmd /c 调用启动器，Claude Desktop、Cursor 等工具可直接使用。'
                      : 'cwd 已自动使用当前仓库目录。'}
                  </Description>
                </div>
                <Button variant="tertiary" onPress={() => copyText(mcpServerJsonTemplate, 'mcpServers 配置')}>
                  <Copy width={14} height={14} />
                  复制 mcpServers 配置
                </Button>
              </section>

              <Separator variant="tertiary" />

              <section className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <Typography type="h5">MCP 客户端</Typography>
                    <Description>连接外部 MCP 服务器并调用其工具。</Description>
                  </div>
                  <Button variant="tertiary" size="sm" onPress={openAddServer}>
                    {serverPanelOpen && !editingServer ? <><Xmark width={14} height={14} /> 收起</> : <><Plus width={14} height={14} /> 添加MCP</>}
                  </Button>
                </div>
                {mcpServers.length === 0 && (
                  <Alert status="default">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description>暂无 MCP 服务器配置，点击上方按钮添加。</Alert.Description>
                    </Alert.Content>
                  </Alert>
                )}
                {serverPanelOpen && !editingServer && renderServerForm()}
                {mcpServers.map(renderServerRow)}
              </section>
            </div>
          </Tabs.Panel>

          <Tabs.Panel id="skills" className="pt-3">
            <div className="flex flex-col gap-3">
              <section className="flex flex-col gap-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <Typography type="h5">Skills</Typography>
                    <Description>管理 CipherTalk 使用的 Skills，也可以导出给外部 Agent。</Description>
                  </div>
                  <ButtonGroup variant="tertiary" size="sm">
                    <Button onPress={downloadSkillTemplate}>
                      <ArrowDownToLine width={14} height={14} />
                      下载模板
                    </Button>
                    <Button onPress={importSkill}>
                      <ButtonGroup.Separator />
                      <ArrowUpToLine width={14} height={14} />
                      导入
                    </Button>
                  </ButtonGroup>
                </div>
                {skills.length === 0 ? (
                  <Alert status="default">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Description>暂无 Skills，可先下载模板后导入 zip。</Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : skills.map(renderSkillRow)}
              </section>
            </div>
          </Tabs.Panel>
        </Tabs>
      </ScrollShadow>

      {/* ── Tools Modal ── */}
      <Modal isOpen={toolDialogServer !== null}
        onOpenChange={(open) => { if (!open) setToolDialogServer(null) }}>
        <Modal.Backdrop>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Icon><PlugConnection width={20} height={20} /></Modal.Icon>
                <Modal.Heading>工具预览: {toolDialogServer}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>{toolDialogServer && renderToolsContent(toolDialogServer)}</Modal.Body>
              <Modal.Footer><Button slot="close" variant="tertiary">关闭</Button></Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

      {/* ── Skill Edit Modal ── */}
      <Modal isOpen={skillDialog !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSkillDialog(null)
          }
        }}>
        <Modal.Backdrop>
          <Modal.Container size="lg">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Icon><FileCode width={20} height={20} /></Modal.Icon>
                <Modal.Heading>编辑 Skill: {skillDialog?.name}</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <TextArea value={editingSkillContent}
                  onChange={(e) => setEditingSkillContent(e.target.value)}
                  className="min-h-[60vh]" />
              </Modal.Body>
              <Modal.Footer>
                <Button slot="close" variant="tertiary">取消</Button>
                <Button variant="primary" onPress={saveEditSkill}>保存</Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>

    </>
  )
}

export default McpPage
