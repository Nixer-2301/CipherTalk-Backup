/**
 * 提示词输入框工具栏上的几个小按钮/桥接组件：预设菜单、斜杠命令、发送按钮、代码工作区权限下拉。
 * 从 AgentPage.tsx 拆出。
 */
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react'
import { Button as HeroButton, ButtonGroup, Dropdown, Header, Label, toast } from '@heroui/react'
import { ChevronDown, Sparkles } from '@gravity-ui/icons'
import type { IconComponent } from '@/types/icon'
import type { ChatStatus } from 'ai'
import {
  usePromptInputController,
  type PromptInputControllerProps,
} from '@/components/ai-elements/prompt-input'
import { HoldToTalkSubmit } from '@/components/ai-elements/hold-to-talk-submit'
import type { AgentToolApprovalPolicy } from '@/types/electron'
import {
  AGENT_TOOL_APPROVAL_POLICY_OPTIONS,
  PROMPT_PRESET_GROUPS,
  agentToolApprovalPolicyOption,
  agentToolApprovalPolicyToneClass,
} from './agentPromptPresets'

function removeLeadingSlashCommand(value: string) {
  const match = value.match(/^\/[^\s/]{0,32}$/)
  if (!match) return value
  return ''
}

export function AgentToolApprovalPolicyDropdown({
  policy,
  onChange,
}: {
  policy: AgentToolApprovalPolicy
  onChange: (policy: AgentToolApprovalPolicy) => void
}) {
  const current = agentToolApprovalPolicyOption(policy)
  const CurrentIcon = current.icon
  const currentToneClass = agentToolApprovalPolicyToneClass(current.value)

  return (
    <Dropdown>
      <HeroButton
        aria-label="设置 Agent 工具审批策略"
        className={`gap-1 ${currentToneClass}`}
        size="sm"
        variant="tertiary"
      >
        <CurrentIcon className="size-3.5 shrink-0" />
        <span className="max-w-24 truncate">{current.label}</span>
        <ChevronDown className="size-3 shrink-0" />
      </HeroButton>
      <Dropdown.Popover className="w-80 max-w-[calc(100vw-2rem)]" placement="top start">
        <div className="border-border/70 border-b px-3 py-2.5">
          <Label className="text-sm">如何批准 Agent 的高风险操作？</Label>
        </div>
        <Dropdown.Menu
          selectedKeys={new Set([current.value])}
          selectionMode="single"
          onAction={(key) => onChange(String(key) as AgentToolApprovalPolicy)}
        >
          {AGENT_TOOL_APPROVAL_POLICY_OPTIONS.map((option) => {
            const Icon = option.icon
            const toneClass = agentToolApprovalPolicyToneClass(option.value)
            return (
              <Dropdown.Item id={option.value} key={option.value} textValue={option.label}>
                <Dropdown.ItemIndicator />
                <Icon className={`size-4 shrink-0 ${toneClass || 'text-muted'}`} />
                <div className="min-w-0 flex-1">
                  <Label className={`block truncate ${toneClass}`}>{option.label}</Label>
                  <span className="block truncate text-muted-foreground text-xs">{option.description}</span>
                </div>
              </Dropdown.Item>
            )
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

export function PromptPresetButton({ showGroupSeparator = false }: { showGroupSeparator?: boolean }) {
  const { textInput } = usePromptInputController()
  const [isOpen, setIsOpen] = useState(false)

  const applyPreset = (text: string) => {
    textInput.setInput(text)
    setIsOpen(false)
  }

  return (
    <Dropdown isOpen={isOpen} onOpenChange={setIsOpen}>
      <HeroButton aria-label="打开提示词列表" className="size-8 p-0" isIconOnly size="sm" variant="tertiary" onPress={() => setIsOpen(true)}>
        {showGroupSeparator && <ButtonGroup.Separator />}
        <Sparkles className="size-3.5" />
      </HeroButton>
      <Dropdown.Popover className="min-w-64 overflow-hidden" placement="top start">
        <Dropdown.Menu className="ct-agent-scrollbar max-h-[min(20rem,52vh)] overflow-y-auto">
          {PROMPT_PRESET_GROUPS.map(({ group, presets }) => (
            <Dropdown.Section key={group}>
              <Header>{group}</Header>
              {presets.map((preset) => {
                const Icon = preset.icon
                return (
                  <Dropdown.Item id={`preset-${preset.label}`} key={preset.label} textValue={preset.label} onAction={() => applyPreset(preset.text)}>
                    <Icon className="size-4 shrink-0 text-muted" />
                    <Label>{preset.label}</Label>
                  </Dropdown.Item>
                )
              })}
            </Dropdown.Section>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

export type SlashCommandItem = {
  aliases?: string[]
  commands: string[]
  description: string
  icon: IconComponent
  id: string
  label: string
  action: () => void | Promise<void>
}

type SlashCommandButtonProps = {
  commands: SlashCommandItem[]
  showGroupSeparator?: boolean
}

export function SlashCommandButton({
  commands,
  showGroupSeparator = false,
}: SlashCommandButtonProps) {
  const { textInput } = usePromptInputController()
  const value = textInput.value
  const slashMatch = value.match(/^\/([^\s/]{0,32})$/)
  const query = slashMatch ? slashMatch[1].toLowerCase() : null
  const [manualOpen, setManualOpen] = useState(false)
  const applyingCommandRef = useRef(false)
  const isOpen = manualOpen || query !== null
  const filteredCommands = useMemo(
    () => commands.filter((command) => {
      if (!query) return true
      const haystack = [...command.commands, command.label, command.description, ...(command.aliases || [])].join(' ').toLowerCase()
      return haystack.includes(query)
    }),
    [commands, query]
  )

  const openSlashMenu = () => {
    setManualOpen(true)
  }

  const cancelSlashMenu = () => {
    setManualOpen(false)
    const next = removeLeadingSlashCommand(textInput.value)
    if (next !== textInput.value) textInput.setInput(next)
  }

  const handleOpenChange = (open: boolean) => {
    if (open) {
      setManualOpen(true)
      return
    }
    if (applyingCommandRef.current) {
      applyingCommandRef.current = false
      setManualOpen(false)
      return
    }
    cancelSlashMenu()
  }

  const applyCommand = (command: typeof commands[number]) => {
    applyingCommandRef.current = true
    const next = removeLeadingSlashCommand(textInput.value)
    if (next !== textInput.value) textInput.setInput(next)
    setManualOpen(false)
    void command.action()
  }

  return (
    <Dropdown isOpen={isOpen} onOpenChange={handleOpenChange}>
      <HeroButton aria-label="打开斜杠命令" className="size-8 p-0" isIconOnly size="sm" variant="tertiary" onPress={openSlashMenu}>
        {showGroupSeparator && <ButtonGroup.Separator />}
        <span aria-hidden className="text-sm font-semibold leading-none">/</span>
      </HeroButton>
      <Dropdown.Popover className="ct-agent-scrollbar max-h-72 min-w-72 overflow-y-auto" placement="top start">
        <Dropdown.Menu>
          <Dropdown.Section>
            <Header>斜杠命令</Header>
            {filteredCommands.length > 0
              ? filteredCommands.map((command) => {
                  const Icon = command.icon
                  return (
                    <Dropdown.Item id={command.id} key={command.id} textValue={`${command.commands.join(' ')} ${command.label}`} onAction={() => applyCommand(command)}>
                      <Icon className="size-4 shrink-0 text-muted" />
                      <div className="flex min-w-0 flex-1 flex-col">
                        <Label>{command.label}</Label>
                        <span className="truncate text-muted-foreground text-xs">{command.description}</span>
                      </div>
                      <span className="ml-auto shrink-0 rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {command.commands[0]}
                      </span>
                    </Dropdown.Item>
                  )
                })
              : (
                  <Dropdown.Item id="slash-empty" textValue="没有匹配的斜杠命令">
                    <Label className="text-muted-foreground">没有匹配的斜杠命令</Label>
                  </Dropdown.Item>
                )}
          </Dropdown.Section>
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  )
}

/** 发送按钮：短按提交/停止，长按语音输入（转写结果追加进输入框），与克隆聊天页一致 */
export function AgentPromptPrimaryAction({ busy, status }: { busy: boolean; status: ChatStatus; workspaceReferenceCount: number }) {
  const { textInput } = usePromptInputController()

  // 空输入不禁用按钮：长按录音需要它可按；空的短按由表单 onSubmit 判空忽略
  return (
    <HoldToTalkSubmit
      holdDisabled={busy}
      voiceInputEnabled={!textInput.value.trim()}
      status={status}
      onTranscript={(text) => {
        const current = textInput.value
        textInput.setInput(current + (current ? ' ' : '') + text)
      }}
      onVoiceError={(message) => toast.danger(message, { timeout: 3000 })}
    />
  )
}

export function PromptInputControllerBridge({
  controllerRef,
}: {
  controllerRef: MutableRefObject<PromptInputControllerProps | null>
}) {
  const controller = usePromptInputController()
  useEffect(() => {
    controllerRef.current = controller
    return () => {
      if (controllerRef.current === controller) controllerRef.current = null
    }
  }, [controller, controllerRef])
  return null
}
