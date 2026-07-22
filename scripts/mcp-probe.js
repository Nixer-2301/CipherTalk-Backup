const path = require('path')

function parseToolArgs(raw) {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Tool arguments must be a JSON object.')
    }
    return parsed
  } catch (error) {
    throw new Error(`Invalid tool arguments JSON: ${String(error.message || error)}`)
  }
}

function extractContentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .map((item) => typeof item?.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n')
}

async function main() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js')

  const mode = process.argv[2] || 'dev'
  const toolName = process.argv[3] || ''
  const toolArgs = parseToolArgs(process.argv[4] || '')
  const cwd = process.cwd()
  let command
  let args
  let transportCwd = cwd

  if (mode === 'packaged') {
    const launcherPath = process.argv[3] || (
      process.platform === 'darwin'
        ? path.join(cwd, 'CipherTalk.app', 'Contents', 'MacOS', 'ciphertalk-mcp')
        : path.join(cwd, 'ciphertalk-mcp.cmd')
    )
    command = launcherPath
    args = []
    transportCwd = path.dirname(launcherPath)
  } else {
    command = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    args = ['run', 'mcp']
  }

  const transport = new StdioClientTransport({
    command,
    args,
    cwd: transportCwd,
    stderr: 'pipe'
  })

  const client = new Client({
    name: 'ciphertalk-mcp-probe',
    version: '1.0.0'
  })

  try {
    await client.connect(transport)
    const tools = await client.listTools()
    const toolNames = (tools.tools || []).map((tool) => tool.name)

    if (!toolName) {
      const health = await client.callTool({ name: 'health_check', arguments: {} })
      console.log(JSON.stringify({
        mode,
        tools: toolNames,
        health
      }, null, 2))
      return
    }

    const result = await client.callTool({ name: toolName, arguments: toolArgs })
    console.log(JSON.stringify({
      mode,
      tools: toolNames,
      toolName,
      arguments: toolArgs,
      summaryText: extractContentText(result.content),
      content: result.content,
      structuredContent: result.structuredContent,
      isError: result.isError
    }, null, 2))
  } finally {
    await client.close()
  }
}

main().catch((error) => {
  console.error('[CipherTalk MCP Probe] failed:', error)
  process.exit(1)
})
