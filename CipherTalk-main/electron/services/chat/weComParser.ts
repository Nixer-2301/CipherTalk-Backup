export function decodeExtraBuffer(extraBuffer: any): Buffer | null {
  if (!extraBuffer) return null
  if (Buffer.isBuffer(extraBuffer)) return extraBuffer
  if (extraBuffer instanceof Uint8Array) return Buffer.from(extraBuffer)
  if (Array.isArray(extraBuffer)) return Buffer.from(extraBuffer)
  if (typeof extraBuffer === 'object' && extraBuffer.type === 'bytes' && typeof extraBuffer.value === 'string') {
    return Buffer.from(extraBuffer.value, 'base64')
  }
  if (typeof extraBuffer === 'object' && Array.isArray(extraBuffer.data)) {
    return Buffer.from(extraBuffer.data)
  }
  if (typeof extraBuffer !== 'string') return null

  const trimmed = extraBuffer.trim()
  if (!trimmed) return null
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length % 2 === 0) {
    return Buffer.from(trimmed, 'hex')
  }
  return Buffer.from(trimmed, 'base64')
}

export function readProtoVarint(data: Buffer, start: number): { value: number; next: number } | null {
  let value = 0
  let shift = 0
  for (let offset = start; offset < data.length && shift <= 28; offset++) {
    const byte = data[offset]
    value += (byte & 0x7f) * (2 ** shift)
    if ((byte & 0x80) === 0) {
      return { value, next: offset + 1 }
    }
    shift += 7
  }
  return null
}

/**
 * extra_buffer 的前两个 protobuf 字段分别是 openim app_id 与企业 wording_id。
 * 企业展示名本身存于 openim_wording 表，不在 contact 记录里。
 */
export function extractWeComWordingRef(extraBuffer: any): { appId?: string; wordingId: string } | null {
  const data = decodeExtraBuffer(extraBuffer)
  if (!data || data.length === 0) return null

  let appId: string | undefined
  let wordingId: string | undefined
  let offset = 0

  while (offset < data.length) {
    const tag = readProtoVarint(data, offset)
    if (!tag) break
    offset = tag.next

    const fieldNumber = tag.value >>> 3
    const wireType = tag.value & 0x07
    if (wireType === 0) {
      const value = readProtoVarint(data, offset)
      if (!value) break
      offset = value.next
      continue
    }
    if (wireType === 1) {
      offset += 8
      continue
    }
    if (wireType === 5) {
      offset += 4
      continue
    }
    if (wireType !== 2) break

    const length = readProtoVarint(data, offset)
    if (!length || length.value < 0 || length.next + length.value > data.length) break
    offset = length.next + length.value

    const text = data.slice(length.next, offset).toString('utf-8')
    if (text.includes('�')) continue
    if (fieldNumber === 1 && /^\d+$/.test(text)) {
      appId = text
    } else if (fieldNumber === 2 && /@im\.wxwork$/i.test(text)) {
      wordingId = text
    }
  }

  if (!wordingId) {
    const match = data.toString('utf-8').match(/[A-Za-z0-9]+RI\d+@im\.wxwork/i)
    wordingId = match?.[0]
  }
  return wordingId ? { appId, wordingId } : null
}

/**
 * 从 contact.extra_buffer 中直接提取企业名称，作为旧版本数据库的回退逻辑。
 *
 * extra_buffer 是 protobuf-like 格式：连续的 [tag][length][value] 段。
 * WeCom 联系人通常包含若干 UTF-8 字符串字段（昵称、手机号、企业名、职位等），
 * 这里把所有可解码字符串收集出来，按启发式过滤后取最像企业名的那一项。
 */
export function extractWeComCorpName(extraBuffer: any, knownStrings: Array<string | undefined>): string | undefined {
  try {
    const data = decodeExtraBuffer(extraBuffer)
    if (!data || data.length < 4) return undefined

    const candidates: string[] = []
    let offset = 0
    while (offset < data.length - 1) {
      const tag = data[offset]
      offset++
      let length = data[offset]
      offset++

      // 长度可能是变长编码（最高位为续位指示）
      if (length > 127 && offset < data.length) {
        const ext = data[offset]
        length = (length & 0x7f) | (ext << 7)
        if (length > data.length) {
          length = data[offset - 1] & 0x7f
        } else {
          offset++
        }
      }

      if (length <= 0 || offset + length > data.length) {
        continue
      }

      const slice = data.slice(offset, offset + length)
      offset += length

      // 尝试 UTF-8 解码，结果合法（无 \0、可显示字符）才采纳
      const str = slice.toString('utf-8')
      if (!str || str.length < 2 || str.length > 50) continue
      if (/^@/.test(str)) continue
      if (/[\x00-\x1F\x7F�]/.test(str)) continue
      candidates.push(str)
      // 标记位置避免快速回退导致无限循环
      if (tag === 0) break
    }

    if (candidates.length === 0) return undefined

    const known = new Set(
      knownStrings.filter((s): s is string => typeof s === 'string' && s.length > 0)
    )

    const looksLikePhone = (s: string) => /^\+?\d[\d\s\-]{6,}$/.test(s)
    const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s) || /\.(com|cn|net|org)\b/i.test(s)
    const looksLikeEmail = (s: string) => /@.+\./.test(s)
    const looksLikeWxid = (s: string) => /^wxid_/.test(s) || /@openim$/i.test(s)
    const looksLikeName = (s: string) => {
      // 含中文/英文/数字（公司名特征），允许中文、字母、数字、（）、&、·、空格、-
      return /[一-龥A-Za-z]/.test(s) && !/^[\d.\-+\s]+$/.test(s)
    }

    // 优先取较长的候选（企业名通常 ≥ 3 字符）；同时排除已知名称、手机号、URL、wxid
    const ranked = candidates
      .filter(s => !known.has(s))
      .filter(s => !looksLikePhone(s))
      .filter(s => !looksLikeUrl(s))
      .filter(s => !looksLikeEmail(s))
      .filter(s => !looksLikeWxid(s))
      .filter(looksLikeName)
      // 公司名长度通常 3-30，优先 3+；同等条件下长度大的排前
      .sort((a, b) => {
        const aGood = a.length >= 3 ? 1 : 0
        const bGood = b.length >= 3 ? 1 : 0
        if (aGood !== bGood) return bGood - aGood
        return b.length - a.length
      })

    return ranked[0]
  } catch {
    return undefined
  }
}
