import { jsonSchema, tool, type ToolSet } from 'ai'
import type { AgentMcpToolDescriptor } from '../types'
import { proxyMcpCallTool } from '../mcpProxyClient'

const MAX_TEXT = 4000
const MAX_RESULT_TEXT = 16_000
const MAX_ARRAY_ITEMS = 20
const MAX_OBJECT_KEYS = 40
const MAX_DEPTH = 4

function trimText(value: string, max = MAX_TEXT): string {
  return value.length > max ? `${value.slice(0, max)}\n...<truncated>` : value
}

function sanitizeValue(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') return trimText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (depth >= MAX_DEPTH) return '[truncated]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item, depth + 1))
    if (value.length > MAX_ARRAY_ITEMS) items.push(`...<${value.length - MAX_ARRAY_ITEMS} more items>`)
    return items
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const entries = Object.entries(value as Record<string, unknown>)
    for (const [key, val] of entries.slice(0, MAX_OBJECT_KEYS)) {
      out[key] = sanitizeValue(val, depth + 1)
    }
    if (entries.length > MAX_OBJECT_KEYS) out.__truncatedKeys = entries.length - MAX_OBJECT_KEYS
    return out
  }
  return String(value)
}

function sanitizeResult(value: unknown): unknown {
  const sanitized = sanitizeValue(value)
  try {
    const text = JSON.stringify(sanitized)
    if (text.length <= MAX_RESULT_TEXT) return sanitized
    return {
      truncated: true,
      text: trimText(text, MAX_RESULT_TEXT),
    }
  } catch {
    return trimText(String(sanitized), MAX_RESULT_TEXT)
  }
}

function normalizeArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

export function buildMcpTools(descriptors: AgentMcpToolDescriptor[] = []): ToolSet {
  const out: ToolSet = {}
  for (const descriptor of descriptors) {
    out[descriptor.name] = tool({
      description: descriptor.description || `外部 MCP 工具：${descriptor.serverName}/${descriptor.toolName}`,
      inputSchema: jsonSchema(descriptor.inputSchema || { type: 'object', properties: {}, additionalProperties: false }),
      execute: async (input) => {
        try {
          const result = await proxyMcpCallTool(descriptor.serverName, descriptor.toolName, normalizeArgs(input))
          return {
            serverName: descriptor.serverName,
            toolName: descriptor.toolName,
            result: sanitizeResult(result),
          }
        } catch (e) {
          return {
            serverName: descriptor.serverName,
            toolName: descriptor.toolName,
            error: e instanceof Error ? e.message : String(e),
          }
        }
      },
    })
  }
  return out
}
