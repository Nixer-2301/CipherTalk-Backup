/**
 * 输入框上方的统一审批条 —— AI SDK toolApproval（发送/导出/任务/MCP）和代码工作区 diff/命令审批
 * 共用一处呈现：一行动态说明 + 确认/拒绝按钮。代码工作区那条点说明展开看 diff/命令详情（AlertDialog）。
 * 两条线路都有待处理项时堆叠显示。聊天气泡里不再放确认/拒绝按钮，避免两处都能点导致重复操作。
 */
import { Button as HeroButton } from '@heroui/react'
import { Check, Code, ShieldExclamation, Xmark } from '@gravity-ui/icons'
import type { CodeWorkspaceApprovalRequest } from '@/types/electron'
import { describeCodeWorkspaceApproval } from './CodeWorkspacePanel'

export type ToolApprovalBarItem = {
  approvalId: string
  toolName: string
  description: string
}

type AgentApprovalBarProps = {
  codeWorkspaceApproval: CodeWorkspaceApprovalRequest | null
  onCodeWorkspaceApprove: (requestId: string) => void
  onCodeWorkspaceReject: (requestId: string) => void
  onExpandCodeWorkspaceApproval: () => void
  onToolApprove: (approvalId: string, approved: boolean) => void
  toolApprovals: ToolApprovalBarItem[]
}

export function AgentApprovalBar({
  codeWorkspaceApproval,
  onCodeWorkspaceApprove,
  onCodeWorkspaceReject,
  onExpandCodeWorkspaceApproval,
  onToolApprove,
  toolApprovals,
}: AgentApprovalBarProps) {
  if (toolApprovals.length === 0 && !codeWorkspaceApproval) return null

  return (
    <div className="mb-2 flex w-full flex-col gap-1.5">
      {toolApprovals.map((item) => (
        <div
          className="flex items-center gap-2 rounded-[40px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm [corner-shape:superellipse(1.7)]"
          key={item.approvalId}
        >
          <ShieldExclamation className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <span className="min-w-0 flex-1 truncate text-foreground">{item.description}</span>
          <HeroButton onPress={() => onToolApprove(item.approvalId, false)} size="sm" variant="secondary">
            <Xmark className="size-3.5" />
            拒绝
          </HeroButton>
          <HeroButton onPress={() => onToolApprove(item.approvalId, true)} size="sm" variant="primary">
            <Check className="size-3.5" />
            确认执行
          </HeroButton>
        </div>
      ))}
      {codeWorkspaceApproval && (
        <div className="flex items-center gap-2 rounded-[40px] border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm [corner-shape:superellipse(1.7)]">
          <Code className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          <button
            className="min-w-0 flex-1 truncate text-left text-foreground underline-offset-2 hover:underline"
            onClick={onExpandCodeWorkspaceApproval}
            title="点击查看 diff/命令详情"
            type="button"
          >
            {describeCodeWorkspaceApproval(codeWorkspaceApproval)}
          </button>
          <HeroButton onPress={() => onCodeWorkspaceReject(codeWorkspaceApproval.requestId)} size="sm" variant="secondary">
            <Xmark className="size-3.5" />
            拒绝
          </HeroButton>
          <HeroButton onPress={() => onCodeWorkspaceApprove(codeWorkspaceApproval.requestId)} size="sm" variant="primary">
            <Check className="size-3.5" />
            批准
          </HeroButton>
        </div>
      )}
    </div>
  )
}
