const { spawn } = require('child_process')
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const electronBinary = require('electron')

const rootDir = path.resolve(__dirname, '..')
const entry = path.join(rootDir, 'dist-electron', 'mcp.js')

if (!fs.existsSync(entry)) {
  process.stderr.write('[CipherTalk MCP Runner] dist-electron/mcp.js not found, running build:mcp...\n')
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const build = spawnSync(npmCmd, ['run', 'build:mcp'], {
    cwd: rootDir,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true
  })

  if (build.status !== 0 || !fs.existsSync(entry)) {
    process.stderr.write('[CipherTalk MCP Runner] build:mcp failed, cannot start MCP server\n')
    process.exit(build.status ?? 1)
  }
}

const child = spawn(electronBinary, [entry], {
  cwd: rootDir,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    CIPHERTALK_MCP_LAUNCHER: 'dev-runner'
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
})

if (process.stdin) {
  process.stdin.pipe(child.stdin)
}

if (child.stdout) {
  child.stdout.pipe(process.stdout)
}

if (child.stderr) {
  child.stderr.pipe(process.stderr)
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on('error', (error) => {
  process.stderr.write(`[CipherTalk MCP Runner] failed: ${String(error)}\n`)
  process.exit(1)
})
