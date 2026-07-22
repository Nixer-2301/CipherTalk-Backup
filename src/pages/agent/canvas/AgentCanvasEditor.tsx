/**
 * Canvas 编辑器 —— V1 受控 textarea（文档 §11.4：Markdown 先用 textarea，代码后续再接 CodeMirror）。
 * 只负责文本；revision、自动保存、冲突逻辑统一在 useAgentCanvas。
 */
import type { AgentCanvasKind } from './agentCanvasTypes'

export interface AgentCanvasEditorProps {
  kind: AgentCanvasKind
  value: string
  disabled?: boolean
  onChange: (value: string) => void
}

export function AgentCanvasEditor({ kind, value, disabled, onChange }: AgentCanvasEditorProps) {
  return (
    <textarea
      aria-label={kind === 'code' ? '代码画布编辑器' : '文档画布编辑器'}
      className={`ct-agent-scrollbar h-full w-full resize-none bg-transparent px-4 py-3 text-foreground text-sm leading-6 outline-none placeholder:text-muted-foreground ${
        kind === 'code' ? 'whitespace-pre font-mono' : ''
      }`}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      placeholder={kind === 'code' ? '在这里编写代码…' : '在这里编写内容，支持 Markdown…'}
      spellCheck={false}
      value={value}
    />
  )
}
