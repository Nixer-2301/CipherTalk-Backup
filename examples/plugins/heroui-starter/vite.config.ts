import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// 插件视图在 iframe 内加载。
// - 开发（serve）：base 设为 '/dist/'，让 dev server 挂在与 manifest entry 相同的
//   路径上，HMR 才能命中 http://localhost:5173/dist/index.html。
// - 构建（build）：base 设为 './'，产物走 ct-plugin:// 相对路径。
export default defineConfig(({ command }) => ({
  base: command === 'serve' ? '/dist/' : './',
  plugins: [tailwindcss(), react()],
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
}))
