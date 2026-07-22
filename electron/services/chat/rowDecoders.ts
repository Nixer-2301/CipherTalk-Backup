import * as fzstd from 'fzstd'

export function coerceRowNumber(value: any, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback
  if (typeof value === 'bigint') return Number(value)
  const text = String(value).trim()
  if (!text) return fallback
  const parsed = Number(text)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function coerceRowString(value: any): string | undefined {
  if (value === null || value === undefined) return undefined
  if (Buffer.isBuffer(value)) return value.toString('utf-8')
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf-8')
  const text = String(value).trim()
  return text || undefined
}

/**
 * 从行数据中获取字段值（支持多种字段名）
 */
export function getRowField(row: Record<string, any>, fieldNames: string[]): any {
  for (const name of fieldNames) {
    if (row[name] !== undefined && row[name] !== null) {
      return row[name]
    }
  }
  const lowerMap = new Map<string, string>()
  for (const actual of Object.keys(row || {})) {
    lowerMap.set(actual.toLowerCase(), actual)
  }
  for (const name of fieldNames) {
    const actual = lowerMap.get(name.toLowerCase())
    if (actual && row[actual] !== undefined && row[actual] !== null) {
      return row[actual]
    }
  }
  return undefined
}

/**
 * 解码 packed_info 数据
 */
export function decodePackedInfo(raw: any): Buffer | null {
  if (!raw) return null
  if (Buffer.isBuffer(raw)) return raw
  if (raw instanceof Uint8Array) return Buffer.from(raw)
  if (Array.isArray(raw)) return Buffer.from(raw)
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (/^[a-fA-F0-9]+$/.test(trimmed) && trimmed.length % 2 === 0) {
      try {
        return Buffer.from(trimmed, 'hex')
      } catch { }
    }
    try {
      return Buffer.from(trimmed, 'base64')
    } catch { }
  }
  if (typeof raw === 'object' && Array.isArray(raw.data)) {
    return Buffer.from(raw.data)
  }
  return null
}

/**
 * 从 XML 中提取属性值
 */
export function extractXmlAttribute(xml: string, tagName: string, attrName: string): string {
  // 匹配 <tagName ... attrName="value" ... /> 或 <tagName ... attrName="value" ...>
  const regex = new RegExp(`<${tagName}[^>]*\\s${attrName}\\s*=\\s*['"]([^'"]*)['"']`, 'i')
  const match = regex.exec(xml)
  return match ? match[1] : ''
}

export function extractXmlValue(xml: string, tagName: string): string {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`, 'i')
  const match = regex.exec(xml)
  if (match) {
    return match[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').trim()
  }
  return ''
}

export function decodeHtmlEntities(content: string): string {
  const decodeCodePoint = (value: string, radix: 10 | 16, fallback: string): string => {
    const codePoint = Number.parseInt(value, radix)
    if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return fallback
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return fallback
    }
  }

  return String(content || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (entity, hex) => decodeCodePoint(hex, 16, entity))
    .replace(/&#(\d+);/g, (entity, dec) => decodeCodePoint(dec, 10, entity))
}

export function cleanString(str: string): string {
  if (!str) return ''
  if (Buffer.isBuffer(str)) {
    str = str.toString('utf-8')
  }
  return String(str).replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, '')
}

export function cleanSystemMessage(content: string): string {
  // 移除 XML 声明
  let cleaned = content.replace(/<\?xml[^?]*\?>/gi, '')
  // 移除所有 XML/HTML 标签
  cleaned = cleaned.replace(/<[^>]+>/g, '')
  // 移除尾部的数字（如撤回消息后的时间戳）
  cleaned = cleaned.replace(/\d+\s*$/, '')
  // 清理多余空白
  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return cleaned || '[系统消息]'
}

export function stripSenderPrefix(content: string): string {
  return content.replace(/^[\s]*([a-zA-Z0-9_-]+):(?!\/\/)\s*/, '')
}

/**
 * 检查是否像 hex 编码
 */
export function looksLikeHex(s: string): boolean {
  if (s.length % 2 !== 0) return false
  return /^[0-9a-fA-F]+$/.test(s)
}

/**
 * 检查是否像 base64 编码
 */
export function looksLikeBase64(s: string): boolean {
  if (s.length % 4 !== 0) return false
  return /^[A-Za-z0-9+/=]+$/.test(s)
}

/**
 * 判断是否像 wxid
 */
export function looksLikeWxid(text: string): boolean {
  if (!text) return false
  const trimmed = text.trim().toLowerCase()
  if (trimmed.startsWith('wxid_')) return true
  return /^wx[a-z0-9_-]{4,}$/.test(trimmed)
}

/**
 * 解码二进制内容（处理 zstd 压缩）
 */
export function decodeBinaryContent(data: Buffer): string {
  if (data.length === 0) return ''

  try {
    // 检查是否是 zstd 压缩数据 (magic number: 0xFD2FB528)
    if (data.length >= 4) {
      const magic = data.readUInt32LE(0)
      if (magic === 0xFD2FB528) {
        // zstd 压缩，需要解压
        try {
          const decompressed = fzstd.decompress(data)
          return Buffer.from(decompressed).toString('utf-8')
        } catch (e) {
          console.error('zstd 解压失败:', e)
        }
      }
    }

    // 尝试直接 UTF-8 解码
    const decoded = data.toString('utf-8')
    // 检查是否有太多替换字符
    const replacementCount = (decoded.match(/�/g) || []).length
    if (replacementCount < decoded.length * 0.2) {
      return decoded.replace(/�/g, '')
    }

    // 尝试 latin1 解码
    return data.toString('latin1')
  } catch {
    return ''
  }
}

/**
 * 尝试解码可能压缩的内容
 */
export function decodeMaybeCompressed(raw: any): string {
  if (!raw) return ''

  // 如果是 Buffer/Uint8Array
  if (Buffer.isBuffer(raw)) {
    return decodeBinaryContent(raw)
  }

  // 如果是字符串
  if (typeof raw === 'string') {
    if (raw.length === 0) return ''

    // 检查是否是 hex 编码
    // 只有当字符串足够长（超过16字符）且看起来像 hex 时才尝试解码
    // 短字符串（如 "123456" 等纯数字）容易被误判为 hex
    if (raw.length > 16 && looksLikeHex(raw)) {
      const bytes = Buffer.from(raw, 'hex')
      if (bytes.length > 0) {
        return decodeBinaryContent(bytes)
      }
    }

    // 检查是否是 base64 编码
    // 只有当字符串足够长（超过16字符）且看起来像 base64 时才尝试解码
    // 短字符串（如 "test", "home" 等）容易被误判为 base64
    if (raw.length > 16 && looksLikeBase64(raw)) {
      try {
        const bytes = Buffer.from(raw, 'base64')
        return decodeBinaryContent(bytes)
      } catch { }
    }

    // 普通字符串
    return raw
  }

  return ''
}

/**
 * 解码消息内容（处理 BLOB 和压缩数据）
 */
export function decodeMessageContent(messageContent: any, compressContent: any): string {
  // 优先使用 compress_content
  let content = decodeMaybeCompressed(compressContent)
  if (!content || content.length === 0) {
    content = decodeMaybeCompressed(messageContent)
  }
  return content
}
