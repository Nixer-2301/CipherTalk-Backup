#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const distEntry = join(root, 'dist', 'index.js')

if (existsSync(distEntry)) {
  import(pathToFileURL(distEntry).href).catch(handleFatalError)
} else {
  import('tsx/esm')
    .then(() => import(pathToFileURL(join(root, 'src', 'index.ts')).href))
    .catch(handleFatalError)
}

function handleFatalError(error) {
  console.error(error)
  process.exitCode = 1
}
