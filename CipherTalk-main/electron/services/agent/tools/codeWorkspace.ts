import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { proxyCodeWorkspaceCall } from '../codeWorkspaceProxyClient'
import type { CodeWorkspaceRef } from '../codeWorkspaceTypes'

type CodeWorkspaceToolOptions = {
  readOnly?: boolean
}

function callCodeWorkspace(workspace: CodeWorkspaceRef, method: string, args: Record<string, unknown> = {}): Promise<unknown> {
  return proxyCodeWorkspaceCall(method, args, workspace).catch((error) => ({
    success: false,
    error: error instanceof Error ? error.message : String(error),
  }))
}

export function createCodeWorkspaceTools(
  workspace: CodeWorkspaceRef | null | undefined,
  options: CodeWorkspaceToolOptions = {},
): ToolSet {
  if (!workspace?.root) return {}

  const readTools: ToolSet = {
    code_workspace_status: tool({
      description:
        '查看当前代码工作区状态、根目录、dev server 状态和常见项目文件线索。只读。',
      inputSchema: z.object({}),
      execute: async () => callCodeWorkspace(workspace, 'status'),
    }),

    code_list_files: tool({
      description:
        '列出代码工作区或电脑任意可访问目录内的文件和目录。路径可填相对 workspace root 的路径，或本机绝对路径；默认跳过 .git/node_modules/dist/.next/coverage 等目录。',
      inputSchema: z.object({
        path: z.string().default('.').describe('目录路径：相对 workspace root，或本机绝对路径；默认当前工作区根目录'),
        maxDepth: z.number().int().min(0).max(8).default(3).describe('递归深度，默认 3'),
        limit: z.number().int().min(1).max(600).default(200).describe('最多返回多少项，默认 200'),
      }),
      execute: async ({ path, maxDepth, limit }) => callCodeWorkspace(workspace, 'list_files', { path, maxDepth, limit }),
    }),

    code_read_file: tool({
      description:
        '读取代码工作区或电脑任意可访问位置的文本文件。路径可填相对 workspace root 的路径，或本机绝对路径；会拦截二进制、大文件；.env、密钥、证书、token 等敏感文件需要用户高风险确认。',
      inputSchema: z.object({
        path: z.string().min(1).describe('文件路径：相对 workspace root，或本机绝对路径'),
        maxLines: z.number().int().min(1).max(1400).default(1400).describe('最多返回行数，默认 1400'),
      }),
      execute: async ({ path, maxLines }) => callCodeWorkspace(workspace, 'read_file', { path, maxLines }),
    }),

    code_get_dev_server_logs: tool({
      description: '查看当前代码工作区 dev server/命令日志。只读。',
      inputSchema: z.object({}),
      execute: async () => callCodeWorkspace(workspace, 'get_dev_server_logs'),
    }),

    code_get_browser_diagnostics: tool({
      description:
        '打开当前本机预览 URL（或指定 localhost URL）并收集浏览器端 console error/warning、运行时异常、加载失败、渲染进程崩溃等诊断信息。前端页面改动后优先用它确认是否白屏或浏览器报错。',
      inputSchema: z.object({
        url: z.string().optional().describe('要诊断的 localhost/127.0.0.1 URL；省略则使用 code_start_dev_server 检测到的预览 URL'),
        waitMs: z.number().int().min(1000).max(30000).default(1500).describe('页面加载后额外等待时间，默认 1500ms'),
      }),
      execute: async ({ url, waitMs }) => callCodeWorkspace(workspace, 'get_browser_diagnostics', { url, waitMs }),
    }),
  }

  if (options.readOnly) return readTools

  return {
    ...readTools,

    code_replace_in_file: tool({
      description:
        '在代码工作区或电脑任意可访问位置的文本文件中替换一段已有文本。路径可填相对 workspace root 的路径，或本机绝对路径；修改前会展示 diff 并等待用户确认；优先用它做小范围改动。',
      inputSchema: z.object({
        path: z.string().min(1).describe('文件路径：相对 workspace root，或本机绝对路径'),
        search: z.string().min(1).describe('要替换的原文，必须和文件内容完全匹配'),
        replace: z.string().describe('替换后的文本'),
        replaceAll: z.boolean().default(false).describe('是否替换所有匹配项，默认只替换第一处'),
      }),
      execute: async ({ path, search, replace, replaceAll }) => callCodeWorkspace(workspace, 'replace_in_file', {
        path,
        search,
        replace,
        replaceAll,
      }),
    }),

    code_write_file: tool({
      description:
        '创建或覆盖代码工作区或电脑任意可访问位置的文本文件。路径可填相对 workspace root 的路径，或本机绝对路径；写入前会展示 diff 并等待用户确认；不要写入敏感文件，除非用户明确要求。',
      inputSchema: z.object({
        path: z.string().min(1).describe('文件路径：相对 workspace root，或本机绝对路径'),
        content: z.string().describe('完整文件内容'),
      }),
      execute: async ({ path, content }) => callCodeWorkspace(workspace, 'write_file', { path, content }),
    }),

    code_delete_file: tool({
      description:
        '删除代码工作区或电脑任意可访问位置的单个文件。路径可填相对 workspace root 的路径，或本机绝对路径；删除前会展示 diff/删除预览并等待用户确认；不能删除目录。',
      inputSchema: z.object({
        path: z.string().min(1).describe('文件路径：相对 workspace root，或本机绝对路径'),
      }),
      execute: async ({ path }) => callCodeWorkspace(workspace, 'delete_file', { path }),
    }),

    code_run_command: tool({
      description:
        '在代码工作区或电脑任意可访问目录内运行短命令并收集 stdout/stderr。cwd 可填相对 workspace root 的路径，或本机绝对路径；优先用 command + args 结构化执行；需要 &&、管道、重定向、平台终端语法时用 commandLine 走受控 shell。安装依赖、测试、脚本执行都会先请求用户确认。',
      inputSchema: z.object({
        command: z.string().optional().describe('可执行命令，例如 npm、npx、pnpm、node。使用 commandLine 时可省略'),
        args: z.array(z.string()).default([]).describe('命令参数数组，例如 ["install"] 或 ["tsc","--noEmit"]'),
        commandLine: z.string().optional().describe('整行终端命令；会走 shell 并按高风险确认，例如 "npm install && npm run dev"'),
        cwd: z.string().optional().describe('工作目录：相对 workspace root，或本机绝对路径；默认 workspace root'),
        timeoutMs: z.number().int().min(1000).max(300000).optional().describe('超时时间，默认 5 分钟，上限 5 分钟'),
      }),
      execute: async ({ command, args, commandLine, cwd, timeoutMs }) => callCodeWorkspace(workspace, 'run_command', {
        command,
        args,
        commandLine,
        cwd,
        timeoutMs,
      }),
    }),

    code_start_dev_server: tool({
      description:
        '启动前端 dev server 并检测本机预览地址。默认命令是 npm run dev；优先用 command + args，复杂终端语法用 commandLine。长进程由主进程托管，启动前会请求用户确认，只接受 localhost/127.0.0.1 预览。',
      inputSchema: z.object({
        command: z.string().optional().describe('可执行命令，省略则使用 npm。使用 commandLine 时可省略'),
        args: z.array(z.string()).optional().describe('命令参数，省略则使用 ["run","dev"]'),
        commandLine: z.string().optional().describe('整行 dev server 命令；会走 shell 并按高风险确认'),
        cwd: z.string().optional().describe('工作目录：相对 workspace root，或本机绝对路径；默认 workspace root'),
      }),
      execute: async ({ command, args, commandLine, cwd }) => callCodeWorkspace(workspace, 'start_dev_server', {
        command,
        args,
        commandLine,
        cwd,
      }),
    }),

    code_stop_dev_server: tool({
      description: '停止当前工作区 dev server 长进程。',
      inputSchema: z.object({}),
      execute: async () => callCodeWorkspace(workspace, 'stop_dev_server'),
    }),
  }
}
