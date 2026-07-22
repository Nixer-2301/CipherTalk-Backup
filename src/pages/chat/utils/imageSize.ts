export const IMAGE_MAX_WIDTH = 200
export const IMAGE_MAX_HEIGHT = 200
const IMAGE_MIN_SIZE = 80
const DEFAULT_SIZE: ImageDisplaySize = { width: 140, height: 140 }

export interface ImageDisplaySize {
  width: number
  height: number
}

function attrNum(xml: string, attr: string): number {
  const m = new RegExp(`${attr}\\s*=\\s*["'](\\d+)["']`, 'i').exec(xml)
  return m ? parseInt(m[1], 10) : 0
}

/**
 * 从图片消息原始 XML（rawContent）解析缩略图宽高。
 * 优先 cdnthumb*，回退 cdnmid* / cdnhd*。解析不到返回 0。
 */
export function parseImageDimensions(rawContent?: string): { width: number; height: number } {
  if (!rawContent) return { width: 0, height: 0 }
  const width = attrNum(rawContent, 'cdnthumbwidth') || attrNum(rawContent, 'cdnmidwidth') || attrNum(rawContent, 'cdnhdwidth')
  const height = attrNum(rawContent, 'cdnthumbheight') || attrNum(rawContent, 'cdnmidheight') || attrNum(rawContent, 'cdnhdheight')
  return { width, height }
}

/**
 * 根据图片原始宽高计算气泡内显示尺寸（等比缩放并 clamp 到上限）。
 * 占位、解密中、未解密、已解密四态共用同一尺寸，避免解密前后高度跳变。
 * 无宽高信息时回退默认方形尺寸。
 */
export function computeImageDisplaySize(imgwidth?: number, imgheight?: number): ImageDisplaySize {
  const w = Number(imgwidth) || 0
  const h = Number(imgheight) || 0
  if (w <= 0 || h <= 0) return DEFAULT_SIZE

  let width = Math.min(IMAGE_MAX_WIDTH, w)
  let height = width * (h / w)
  if (height > IMAGE_MAX_HEIGHT) {
    height = IMAGE_MAX_HEIGHT
    width = height * (w / h)
  }
  return {
    width: Math.round(Math.max(IMAGE_MIN_SIZE, width)),
    height: Math.round(Math.max(IMAGE_MIN_SIZE, height)),
  }
}

const sizeCache = new WeakMap<object, ImageDisplaySize>()

/**
 * 解析并缓存某条图片消息的显示尺寸。estimateSize 会高频调用，按消息对象缓存避免重复正则。
 */
export function resolveImageDisplaySize(message: { rawContent?: string }): ImageDisplaySize {
  const cached = sizeCache.get(message)
  if (cached) return cached
  const { width, height } = parseImageDimensions(message.rawContent)
  const size = computeImageDisplaySize(width, height)
  sizeCache.set(message, size)
  return size
}
