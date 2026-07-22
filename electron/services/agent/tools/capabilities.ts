import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { proxyAgentCapabilityCall } from '../agentCapabilityProxyClient'

function callCapability(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return proxyAgentCapabilityCall(method, args).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }))
}

export function createLocalFileTools(): ToolSet {
  return {
    find_files: tool({
      description:
        '按文件名、路径、类型、大小、修改时间搜索电脑本机文件。先使用已有轻量索引；无命中时可调用 index_local_files 刷新索引。',
      inputSchema: z.object({
        query: z.string().optional().describe('文件名或路径关键词'),
        types: z.array(z.string()).optional().describe('限定类型，如 document/image/video/audio/text/code/archive'),
        modifiedAfter: z.union([z.string(), z.number()]).optional().describe('修改时间下限，ISO 字符串或毫秒时间戳'),
        modifiedBefore: z.union([z.string(), z.number()]).optional().describe('修改时间上限，ISO 字符串或毫秒时间戳'),
        limit: z.number().int().min(1).max(100).default(30),
      }),
      execute: async (args) => callCapability('find_files', args),
    }),

    search_local_files: tool({
      description:
        '在本机文件内容索引中搜索文本。内容索引默认只覆盖桌面、文档、下载、当前 workspace、导出目录和用户显式 roots；传 roots 可先刷新这些目录。',
      inputSchema: z.object({
        query: z.string().min(1).describe('要搜索的正文关键词'),
        roots: z.array(z.string()).optional().describe('可选：要刷新并搜索的本机目录绝对路径列表'),
        refresh: z.boolean().default(true).describe('传 roots 时是否先刷新内容索引，默认 true'),
        maxFiles: z.number().int().min(1).max(100000).optional().describe('刷新 roots 时最多扫描文件数'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      execute: async (args) => callCapability('search_local_files', args),
    }),

    index_local_files: tool({
      description:
        '建立或刷新本机文件索引。默认轻量扫描全盘文件名/类型/时间；content=true 时只给常用目录或显式 roots 建内容索引。',
      inputSchema: z.object({
        roots: z.array(z.string()).optional().describe('要扫描的目录绝对路径；不传则按默认索引范围'),
        content: z.boolean().default(false).describe('是否抽取文本内容。默认 false，只索引文件元数据'),
        maxFiles: z.number().int().min(1).max(100000).default(20000).describe('最多扫描文件数，默认 20000'),
      }),
      execute: async (args) => callCapability('index_local_files', args),
    }),
  }
}

export function createKnowledgeTools(): ToolSet {
  return {
    add_knowledge_source: tool({
      description:
        '把 PDF、Word、Markdown、HTML、网页或文本加入全局资料库。PDF 第一版只索引元数据；要全文请先转换成 Markdown/文本。',
      inputSchema: z.object({
        path: z.string().optional().describe('本机文件绝对路径'),
        url: z.string().optional().describe('网页 URL'),
        title: z.string().optional().describe('资料标题；不填则自动取文件名或网页 title'),
      }),
      execute: async (args) => callCapability('add_knowledge_source', args),
    }),

    search_knowledge: tool({
      description: '搜索全局资料库里的文档、网页和项目资料，返回来源与内容片段。',
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      execute: async (args) => callCapability('search_knowledge', args),
    }),

    remove_knowledge_source: tool({
      description: '从全局资料库移除一个来源。id 来自 add_knowledge_source 或 search_knowledge。',
      inputSchema: z.object({
        id: z.string().min(1),
      }),
      execute: async (args) => callCapability('remove_knowledge_source', args),
    }),
  }
}

export function createArtifactTools(): ToolSet {
  return {
    create_artifact: tool({
      description:
        '创建本机结果产物文件，支持 html、excel、word、ppt。会写文件；首次参数齐全但 confirmed 不为 true 时只返回 requiresConfirmation。',
      inputSchema: z.object({
        format: z.enum(['html', 'excel', 'word', 'ppt']),
        title: z.string().min(1),
        content: z.string().default(''),
        rows: z.array(z.record(z.string(), z.unknown())).optional().describe('Excel 可选结构化行'),
        outputDir: z.string().optional().describe('输出目录绝对路径；不填用 exportPath 或应用缓存产物目录'),
        fileName: z.string().optional().describe('不带扩展名也可以；工具会按 format 补扩展名'),
        confirmed: z.boolean().default(false).describe('用户最终确认后传 true；确认前不得写文件'),
      }),
      execute: async (args) => callCapability('create_artifact', args),
    }),
  }
}

export function createTaskTools(): ToolSet {
  return {
    create_task: tool({
      description:
        '创建主动/定时任务。任务不得发送微信消息；到期只提醒、生成草稿、写文件或导出，所有高风险动作执行前确认。',
      inputSchema: z.object({
        title: z.string().min(1),
        instruction: z.string().min(1).describe('任务要做什么；不得包含向微信联系人/群主动发消息'),
        trigger: z.record(z.string(), z.unknown()).describe('触发器，如 {type:"daily", time:"21:30"}、{type:"once", at:"2026-06-17T20:00:00+08:00"} 或 {type:"keyword", keyword:"xxx"}'),
      }),
      execute: async (args) => callCapability('create_task', args),
    }),

    list_tasks: tool({
      description: '列出主动/定时任务。',
      inputSchema: z.object({
        status: z.enum(['active', 'cancelled', 'paused']).optional(),
      }),
      execute: async (args) => callCapability('list_tasks', args),
    }),

    update_task: tool({
      description: '更新任务标题、内容或状态；仍不得让任务发送微信消息。',
      inputSchema: z.object({
        id: z.string().min(1),
        title: z.string().optional(),
        instruction: z.string().optional(),
        status: z.enum(['active', 'cancelled', 'paused']).optional(),
      }),
      execute: async (args) => callCapability('update_task', args),
    }),

    cancel_task: tool({
      description: '取消一个主动/定时任务。',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async (args) => callCapability('cancel_task', args),
    }),

    run_task_now: tool({
      description: '手动触发任务。工具只返回任务指令和安全边界，真正执行仍由本轮 Agent 判断并按高风险确认。',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async (args) => callCapability('run_task_now', args),
    }),
  }
}

export function createAuditTools(): ToolSet {
  return {
    list_audit_logs: tool({
      description: '查看 AI 操作审计记录，包括文件写入、产物生成、任务触发、回滚等。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
      }),
      execute: async (args) => callCapability('list_audit_logs', args),
    }),

    rollback_operation: tool({
      description:
        '按审计 operationId 回滚有快照的文件操作。首次调用 confirmed=false 只返回确认信息；用户确认后才能传 confirmed=true。',
      inputSchema: z.object({
        operationId: z.string().min(1),
        confirmed: z.boolean().default(false),
      }),
      execute: async (args) => callCapability('rollback_operation', args),
    }),
  }
}

export function createDesktopTools(): ToolSet {
  return {
    desktop_screenshot: tool({
      description:
        '截取当前屏幕/窗口并保存为本机 PNG 文件。首版只看桌面，不点击、不键入。' +
        '软件内对话里截图只在当前软件内预览/保存，不会自动发送到微信；微信机器人入口下，只有当前用户明确要求截图时才可作为当前会话回复附件。',
      inputSchema: z.object({
        sourceId: z.string().optional().describe('可选 Electron desktopCapturer source id'),
        width: z.number().int().min(320).max(3840).default(1920),
        height: z.number().int().min(240).max(2160).default(1080),
      }),
      execute: async (args) => callCapability('desktop_screenshot', args),
    }),

    desktop_ocr: tool({
      description:
        '对当前屏幕/窗口截图并尝试 OCR。首版不做点击、不键入；未配置 OCR 时返回截图路径和明确错误。' +
        '不要承诺把截图发送到微信或其它联系人。',
      inputSchema: z.object({
        sourceId: z.string().optional(),
        width: z.number().int().min(320).max(3840).default(1920),
        height: z.number().int().min(240).max(2160).default(1080),
      }),
      execute: async (args) => callCapability('desktop_ocr', args),
    }),
  }
}

export function createMemoryGovernanceTools(): ToolSet {
  return {
    audit_memories: tool({
      description: '体检长期记忆，找重复、低置信、待确认、过期记忆，返回可编辑建议。',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(200),
        staleDays: z.number().int().min(1).max(3650).default(180),
      }),
      execute: async (args) => callCapability('audit_memories', args),
    }),

    apply_memory_fix: tool({
      description:
        '应用记忆体检修复。删除/合并记忆属于高风险操作；首次 confirmed=false 只返回确认信息。',
      inputSchema: z.object({
        action: z.enum(['delete', 'consolidate']),
        ids: z.array(z.number().int()).default([]),
        confirmed: z.boolean().default(false),
      }),
      execute: async (args) => callCapability('apply_memory_fix', args),
    }),
  }
}

export function createAgentCapabilityTools(): ToolSet {
  return {
    ...createLocalFileTools(),
    ...createKnowledgeTools(),
    ...createArtifactTools(),
    ...createTaskTools(),
    ...createAuditTools(),
    ...createDesktopTools(),
    ...createMemoryGovernanceTools(),
  }
}
