import { useEffect, useState } from 'react'
import './SplashPage.css'

// 窗口内容尺寸（见 windowManager.createSplashWindow），与图片 16:9 比例一致
const W = 480
const H = 270
const R = 56 // 圆角半径(px)
const N = 3 // 超椭圆指数：2=圆弧，越大越方，苹果 App 图标 ≈5（连续曲率圆角）
const SEG = 16

// 生成连续曲率（超椭圆 squircle）圆角矩形的 clip-path。普通 border-radius 是圆弧，这里用超椭圆四角。
function squirclePath(): string {
  const corner = (cx: number, cy: number, sx: number, sy: number, reverse: boolean): string => {
    let out = ''
    for (let i = 0; i <= SEG; i++) {
      const t = reverse ? (SEG - i) / SEG : i / SEG
      const phi = (t * Math.PI) / 2
      const x = cx + sx * R * Math.cos(phi) ** (2 / N)
      const y = cy + sy * R * Math.sin(phi) ** (2 / N)
      out += `L ${x.toFixed(2)} ${y.toFixed(2)} `
    }
    return out
  }
  return (
    `M ${R} 0 ` +
    `L ${W - R} 0 ` +
    corner(W - R, R, 1, -1, true) +     // 右上：(W-R,0) -> (W,R)
    `L ${W} ${H - R} ` +
    corner(W - R, H - R, 1, 1, false) + // 右下：(W,H-R) -> (W-R,H)
    `L ${R} ${H} ` +
    corner(R, H - R, -1, 1, true) +     // 左下：(R,H) -> (0,H-R)
    `L 0 ${R} ` +
    corner(R, R, -1, -1, false) +       // 左上：(0,R) -> (R,0)
    'Z'
  )
}

function SplashPage() {
  const [fadeOut, setFadeOut] = useState(false)

  useEffect(() => {
    document.body.classList.add('splash-transparent')

    const readyTimer = setTimeout(() => {
      try {
        // @ts-ignore - splashReady 方法在运行时可用
        window.electronAPI?.window?.splashReady?.()
      } catch (e) {
        console.error('通知启动屏就绪失败:', e)
      }
    }, 1000)

    const cleanup = window.electronAPI?.window?.onSplashFadeOut?.(() => setFadeOut(true))

    return () => {
      clearTimeout(readyTimer)
      cleanup?.()
      document.body.classList.remove('splash-transparent')
    }
  }, [])

  return (
    <div className={`splash-page${fadeOut ? ' splash-page--out' : ''}`}>
      <img
        className="splash-img"
        src="./qdp.jpg"
        alt="密语 CipherTalk"
        style={{ clipPath: `path('${squirclePath()}')` }}
      />
      <div className="splash-loading" aria-label="正在加载">
        <span className="splash-dot" />
        <span className="splash-dot" />
        <span className="splash-dot" />
      </div>
    </div>
  )
}

export default SplashPage
