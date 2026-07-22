/**
 * Lottie 动画：LottieFiles 官方 dotLottie 播放器（WASM 渲染），支持 .lottie 与 .json。
 * 关键：默认会从 jsDelivr CDN 拉 WASM，桌面应用必须离线可用，
 * 这里改用 Vite 打包进本地资源的 WASM（?url 导入），并在模块加载时全局生效一次。
 *
 * 用法（动画文件放 src/assets/lottie/）：
 *   import { LottieView } from '@/components/LottieView'
 *   import sparkle from '@/assets/lottie/sparkle.lottie?url'
 *   <LottieView src={sparkle} loop autoplay className="size-24" />
 * 需要手动控制播放时用 dotLottieRefCallback 拿实例（play/pause/setFrame 等）。
 */
import { DotLottieReact, setWasmUrl } from '@lottiefiles/dotlottie-react'
import dotLottieWasmUrl from '@lottiefiles/dotlottie-web/dotlottie-player.wasm?url'

setWasmUrl(dotLottieWasmUrl)

export { DotLottieReact as LottieView }
export type { DotLottie } from '@lottiefiles/dotlottie-react'
