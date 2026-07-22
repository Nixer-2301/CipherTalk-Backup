import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'
import net from 'node:net'
import { builtinModules } from 'module'

const pkg = require('./package.json')
const devServerHost = process.env.VITE_HOST || '127.0.0.1'
const devServerPort = Number(process.env.VITE_PORT || process.env.PORT || 5321)
const nodeBuiltinModules = new Set([
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
])
const shouldBundleElectronDependency = (id: string) => (
  id === 'ai' ||
  id.startsWith('ai/') ||
  id.startsWith('@ai-sdk/')
)
const dependencyExternal = Object.keys(pkg.dependencies || {})
  .filter((name) => !shouldBundleElectronDependency(name))
const external = (id: string) => {
  if (nodeBuiltinModules.has(id)) return true
  if (shouldBundleElectronDependency(id)) return false
  return dependencyExternal.some((name) => id === name || id.startsWith(`${name}/`))
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()

    server.once('error', () => {
      resolve(false)
    })

    server.once('listening', () => {
      server.close(() => resolve(true))
    })

    server.listen(port, host)
  })
}

async function resolveDevServerPort(preferredPort: number, host: string, maxAttempts = 100): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidatePort = preferredPort + offset
    if (await canListen(candidatePort, host)) {
      return candidatePort
    }
  }

  return preferredPort
}

export default defineConfig(async () => {
  const resolvedDevServerPort = await resolveDevServerPort(devServerPort, devServerHost)

  return {
    base: './',
    optimizeDeps: {
      entries: ['index.html']
    },
    server: {
      host: devServerHost,
      port: resolvedDevServerPort,
      strictPort: false  // 如果默认端口不可用，自动尝试后续端口
    },
    plugins: [
      tailwindcss(),
      react(),
      electron([
        {
          entry: 'electron/main.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: {
                external
              }
            }
          }
        },
        {
          entry: 'electron/preload.ts',
          onstart(options) {
            options.reload()
          },
          vite: {
            build: {
              outDir: 'dist-electron'
            }
          }
        },
        {
          entry: 'electron/transcribeWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/imageDecryptWorker.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/wcdbUtilityProcess.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/aiAgentUtilityProcess.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/aiExportUtilityProcess.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/exportUtilityProcess.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/mcp.ts',
          vite: {
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        }
      ]),
      renderer()
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    build: {
      rollupOptions: {
        external: [/^WeFlow\/.*/]
      }
    }
  }
})
