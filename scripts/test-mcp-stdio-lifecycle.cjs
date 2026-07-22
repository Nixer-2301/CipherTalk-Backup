'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('node:test')
const electronBinary = require('electron')

const rootDir = path.resolve(__dirname, '..')
const mcpEntry = path.join(rootDir, 'dist-electron', 'mcp.js')
const readyLine = '[CipherTalk MCP] stdio server started'

function startMcpServer() {
  assert.ok(
    fs.existsSync(mcpEntry),
    'dist-electron/mcp.js is missing; run npm run build:mcp before this test'
  )

  return spawn(electronBinary, [mcpEntry], {
    cwd: rootDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      CIPHERTALK_MCP_LAUNCHER: 'stdio-lifecycle-test'
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
}

function stopMcpServer(child) {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
  }
}

function waitForReady(child, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    let stderr = ''

    const cleanup = () => {
      clearTimeout(timer)
      child.stderr.off('data', onData)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onData = (chunk) => {
      stderr += chunk.toString()
      if (stderr.includes(readyLine)) {
        cleanup()
        resolve()
      }
    }
    const onExit = (code, signal) => {
      cleanup()
      reject(
        new Error(
          `MCP exited before becoming ready (code=${code}, signal=${signal}): ${stderr}`
        )
      )
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`MCP did not become ready within ${timeoutMs}ms: ${stderr}`))
    }, timeoutMs)

    child.stderr.on('data', onData)
    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function waitForExit(child, timeoutMs = 3_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      child.off('exit', onExit)
      child.off('error', onError)
    }
    const onExit = (code, signal) => {
      cleanup()
      resolve({ code, signal })
    }
    const onError = (error) => {
      cleanup()
      reject(error)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`MCP did not exit within ${timeoutMs}ms`))
    }, timeoutMs)

    child.once('exit', onExit)
    child.once('error', onError)
  })
}

function initializeRequest() {
  return `${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'stdio-lifecycle-test', version: '1.0.0' }
    }
  })}\n`
}

test('MCP exits when its stdin client disconnects', { timeout: 10_000 }, async (t) => {
  const child = startMcpServer()
  t.after(() => stopMcpServer(child))

  await waitForReady(child)
  child.stdin.end()

  assert.deepEqual(await waitForExit(child), { code: 0, signal: null })
})

test('MCP exits without an exception loop when output pipes close', { timeout: 10_000 }, async (t) => {
  const child = startMcpServer()
  t.after(() => stopMcpServer(child))

  await waitForReady(child)
  child.stdout.destroy()
  child.stderr.destroy()
  child.stdin.write(initializeRequest())

  assert.deepEqual(await waitForExit(child), { code: 0, signal: null })
})
