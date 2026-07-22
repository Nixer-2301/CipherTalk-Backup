/**
 * 提示词预设 + 思考强度 / 代码工作区权限选项：纯数据 + 小工具函数，从 AgentPage.tsx 拆出。
 */
import { ArrowsRotateLeft, Bulb, ChartColumn, Clock, ClockArrowRotateLeft, Hand, LayoutHeaderCellsLarge, Link, ListCheck, Magnifier, PencilToSquare, Persons, QuoteOpen, ShieldCheck, ShieldExclamation } from '@gravity-ui/icons'
import type { IconComponent } from '@/types/icon'
import type { AgentReasoningEffort } from '@/features/aiagent/transport/ipcChatTransport'
import type { AgentToolApprovalPolicy } from '@/types/electron'

// 提示词预设：按 AI 助手的工具能力分组；需要限定联系人或群时，用户可在正文光标处用 @ 插入。
export const PROMPT_PRESET_GROUPS = [
  {
    group: '回顾总结',
    presets: [
      {
        label: '最近聊了什么',
        text: `请基于我最近一周的聊天记录，做一份结构化回顾。

要求：
1. 按主题归纳主要讨论内容，每个主题说明涉及对象、时间范围和关键结论。
2. 标出重要事项、待办、承诺、风险或情绪变化。
3. 给出 3-5 条值得我优先关注的后续行动。
4. 引用关键原话或聊天片段作为依据，不要凭空推断。
5. 如果数据不足，请说明缺口和你需要我补充的信息。`,
        icon: Clock,
      },
      {
        label: '总结和某人的聊天',
        text: `请先用 @ 提及要总结的联系人或群，然后总结最近一个月我和该对象的聊天记录，输出一份关系与事项复盘。

要求：
1. 按时间线概括重要互动，并标出转折点。
2. 归纳主要话题、反复出现的诉求、共同关注点和未解决事项。
3. 分析交流氛围与情绪变化，但要区分“有证据的判断”和“可能的推测”。
4. 列出对方明确表达过的需求、偏好或边界。
5. 最后给出我下一步可以怎么回复或跟进的建议，并附关键证据。`,
        icon: Persons,
      },
      {
        label: '回顾某天的聊天',
        text: `请回顾指定日期这一天的聊天记录，按时间顺序整理成一份日程式摘要。

日期：请在这里填写具体日期，例如 2026-06-15

要求：
1. 分上午、下午、晚上或按真实时间段梳理发生了什么。
2. 对每段聊天说明对象、主题、结论和需要跟进的事项。
3. 标出重要原话、文件、图片、链接或决定。
4. 单独列出当天最重要的 3 件事。
5. 如果某些记录缺少上下文，请明确说明。`,
        icon: ClockArrowRotateLeft,
      },
    ],
  },
  {
    group: '查找核对',
    presets: [
      {
        label: '找相关记录',
        text: `请在我的聊天记录里检索下面这个目标，并做相关性排序。

检索目标：请在这里写关键词、事件，或用 @ 提及对象

要求：
1. 同时检索精确关键词和语义相关表达，不要只做字面匹配。
2. 每条结果给出时间、聊天对象或群、摘要、相关原因和关键原话。
3. 将结果分为“高度相关 / 可能相关 / 背景资料”。
4. 如果存在多个同名对象或歧义，请先列出歧义并说明你如何判断。
5. 最后总结这件事目前可确认的事实和仍不确定的信息。`,
        icon: Magnifier,
      },
      {
        label: '查证某件事',
        text: `请帮我核对下面这件事在聊天记录中的来源和上下文。

核对事项：请在这里写要查证的事件、说法或关键词

要求：
1. 找出最早出现、最明确表述和后续确认或反驳的记录。
2. 给出是谁、在什么时间、在哪个聊天里说的。
3. 引用关键原话，并解释前后文语境。
4. 区分事实、转述、猜测、玩笑或情绪表达。
5. 最后给出可信度判断，以及还需要哪些证据才能确认。`,
        icon: QuoteOpen,
      },
      {
        label: '找某个主题',
        text: `请找出聊天记录中所有与下面主题相关的内容，并做主题化整理。

主题：请在这里写主题、别称或相关关键词

要求：
1. 不限于关键词命中，请包含语义相关、别称、缩写和上下文暗示。
2. 按子主题归类，每类说明代表性记录、参与对象和时间范围。
3. 标出高频观点、分歧点、重复出现的问题和已达成的结论。
4. 用时间线补充这个主题的发展变化。
5. 最后输出一份可复用的主题摘要和关键证据列表。`,
        icon: Link,
      },
    ],
  },
  {
    group: '统计图表',
    presets: [
      {
        label: '统计高频联系人',
        text: `请统计最近一个月我互动最多的联系人，并给出可解释的分析。

要求：
1. 分别统计消息数量、互动天数、最近一次互动时间和主要互动时段。
2. 区分私聊和群聊中的直接互动，避免把群聊噪声误判为关系强度。
3. 给出 Top 10 排名，并说明每个人的主要聊天主题。
4. 分析互动高峰、异常变化和可能原因。
5. 如适合，请用表格或图表展示，并说明统计口径。`,
        icon: ChartColumn,
      },
      {
        label: '群活跃排行',
        text: `请先用 @ 提及要统计的群，然后统计这个群最近一个月的发言活跃度，并生成一份群活跃分析。

要求：
1. 输出发言 Top 10 成员，包含消息数、占比、活跃天数和典型活跃时段。
2. 识别群内主要话题、关键推动者和沉默但被频繁提及的人。
3. 分析活跃度峰值对应的事件或讨论。
4. 用图表展示排行和趋势，并说明统计口径。
5. 避免把表情、撤回、系统消息等无效内容计入核心分析。`,
        icon: LayoutHeaderCellsLarge,
      },
      {
        label: '聊天量趋势',
        text: `请统计最近三个月我每周的消息收发量，并分析趋势变化。

要求：
1. 按周输出发送量、接收量、总量和环比变化。
2. 标出异常峰值或低谷，并尝试结合聊天内容解释原因。
3. 区分私聊、群聊和朋友圈相关互动（如果数据支持）。
4. 用折线图或柱状图展示趋势，并给出简短结论。
5. 最后总结我的沟通节奏变化和可能需要关注的信号。`,
        icon: ArrowsRotateLeft,
      },
    ],
  },
  {
    group: '朋友圈',
    presets: [
      {
        label: '翻某人朋友圈',
        text: `请先用 @ 提及要查看的联系人，然后整理 TA 最近半年发布的朋友圈内容，做一份内容与状态观察。

要求：
1. 按时间线列出主要动态，概括每条的主题、情绪和可能背景。
2. 归纳 TA 最近关注的人、事、地点、兴趣或生活变化。
3. 标出互动较多或信息量较高的动态。
4. 分析时必须基于可见内容，避免过度解读隐私或动机。
5. 最后给出一份简短画像和我适合如何开启话题的建议。`,
        icon: PencilToSquare,
      },
      {
        label: '朋友圈之最',
        text: `请统计最近半年朋友圈相关数据，输出一份“朋友圈之最”分析。

要求：
1. 统计发布最多、互动最多、点赞或评论最多、最常出现主题等榜单。
2. 对每个榜单说明统计口径和时间范围。
3. 识别异常高互动内容，并总结可能原因。
4. 用表格或图表展示关键排行。
5. 最后给出我社交圈近期关注点和互动结构的总结。`,
        icon: ListCheck,
      },
    ],
  },
  {
    group: '记忆',
    presets: [
      {
        label: '你记住了什么',
        text: `请审计你目前保存的关于我的长期记忆，并输出一份可校对清单。

要求：
1. 按身份信息、偏好、关系、习惯、长期目标、重要事件等类别整理。
2. 每条记忆标注来源依据、置信度和可能过期风险。
3. 找出互相矛盾、含糊、过时或不应继续保留的记忆。
4. 对每条可疑记忆给出建议：保留、修改、删除或需要我确认。
5. 最后列出你还缺少哪些高价值信息，但不要主动编造。`,
        icon: Bulb,
      },
    ],
  },
]

export const REASONING_EFFORT_OPTIONS: Array<{ value: AgentReasoningEffort; label: string }> = [
  { value: 'none', label: '最低' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '超高' },
  { value: 'max', label: '极高' },
]

export function reasoningEffortLabel(value: AgentReasoningEffort, compact = false): string {
  const label = REASONING_EFFORT_OPTIONS.find((option) => option.value === value)?.label ?? '高'
  return compact ? label.replace(/^思考：/, '') : label
}

// 输入框上唯一的审批策略开关：同时控制 AI SDK 工具审批（发送/导出/任务/MCP）和代码工作区审批
// （读敏感文件/编辑/运行命令），两边风险判定逻辑分开，但用户只调一个值，见 AgentPage.tsx 的合并 handler。
export const AGENT_TOOL_APPROVAL_POLICY_OPTIONS: Array<{
  value: AgentToolApprovalPolicy
  label: string
  description: string
  icon: IconComponent
}> = [
  {
    value: 'on-request',
    label: '请求批准',
    description: '发送微信媒体/文件、导出、任务变更、MCP 调用、代码工作区操作时始终询问',
    icon: Hand,
  },
  {
    value: 'risk-based',
    label: '替我审批',
    description: '仅对高风险操作请求批准（发表情包、任务增删改、低风险代码操作自动放行）',
    icon: ShieldExclamation,
  },
  {
    value: 'full-access',
    label: '完全访问',
    description: '所有高风险工具调用和代码操作都不再请求批准',
    icon: ShieldCheck,
  },
]

export function agentToolApprovalPolicyOption(policy?: AgentToolApprovalPolicy) {
  return AGENT_TOOL_APPROVAL_POLICY_OPTIONS.find((option) => option.value === policy)
    ?? AGENT_TOOL_APPROVAL_POLICY_OPTIONS[0]
}

export function agentToolApprovalPolicyToneClass(policy?: AgentToolApprovalPolicy) {
  if (policy === 'risk-based') return 'text-blue-600 dark:text-blue-300'
  if (policy === 'full-access') return 'text-amber-600 dark:text-amber-300'
  return ''
}
