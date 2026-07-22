import { delimiter, join } from 'path'
import { getAppPath, getCipherTalkCodexHome, isElectronPackaged } from './runtimePaths'

function copyProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value
    }
  }
  return env
}

export function getElectronWorkerEnv(): NodeJS.ProcessEnv {
  const env = copyProcessEnv()
  const existingNodePaths = env.NODE_PATH
    ? env.NODE_PATH.split(delimiter).filter(Boolean)
    : []
  const appPath = getAppPath()
  const resourcesRoot = process.resourcesPath || appPath
  const packagedNodePaths = isElectronPackaged()
    ? [
        join(resourcesRoot, 'app.asar.unpacked', 'node_modules'),
        join(resourcesRoot, 'app.asar', 'node_modules'),
        join(resourcesRoot, 'node_modules')
      ]
    : [
        join(appPath, 'node_modules'),
        join(process.cwd(), 'node_modules')
      ]

  env.NODE_PATH = Array.from(new Set([...packagedNodePaths, ...existingNodePaths])).join(delimiter)
  env.CIPHERTALK_CODEX_HOME = getCipherTalkCodexHome()
  return env
}
