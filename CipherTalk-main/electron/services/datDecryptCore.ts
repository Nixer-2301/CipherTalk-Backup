/**
 * dat 图片解密纯函数核心。
 *
 * 只依赖 fs/crypto，无 Electron/服务依赖，主线程与 imageDecryptWorker（worker_threads）共用，
 * 保证两边算法永远一致。从 imageDecryptService 原样抽出，行为不变。
 */
import { readFileSync, existsSync } from 'fs'
import crypto from 'crypto'

export type DatDecryptOutcome = {
  data: Buffer
  source: 'native' | 'ts'
  fallbackReason?: string
}

export const DEFAULT_V1_AES_KEY = 'cfcd208495d565ef'

function compareBytes(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

export function getDatVersion(inputPath: string): number {
  if (!existsSync(inputPath)) {
    throw new Error('文件不存在')
  }
  const bytes = readFileSync(inputPath)
  if (bytes.length < 6) {
    return 0
  }
  const signature = bytes.subarray(0, 6)
  if (compareBytes(signature, Buffer.from([0x07, 0x08, 0x56, 0x31, 0x08, 0x07]))) {
    return 1
  }
  if (compareBytes(signature, Buffer.from([0x07, 0x08, 0x56, 0x32, 0x08, 0x07]))) {
    return 2
  }
  return 0
}

export function asciiKey16(keyString: string): Buffer {
  if (keyString.length < 16) {
    throw new Error('AES密钥至少需要16个字符')
  }
  return Buffer.from(keyString, 'ascii').subarray(0, 16)
}

function bytesToInt32(bytes: Buffer): number {
  if (bytes.length !== 4) {
    throw new Error('需要4个字节')
  }
  return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
}

function strictRemovePadding(data: Buffer): Buffer {
  if (!data.length) {
    throw new Error('解密结果为空，填充非法')
  }
  const paddingLength = data[data.length - 1]
  if (paddingLength === 0 || paddingLength > 16 || paddingLength > data.length) {
    throw new Error('PKCS7 填充长度非法')
  }
  for (let i = data.length - paddingLength; i < data.length; i += 1) {
    if (data[i] !== paddingLength) {
      throw new Error('PKCS7 填充内容非法')
    }
  }
  return data.subarray(0, data.length - paddingLength)
}

export function decryptDatV3(inputPath: string, xorKey: number): Buffer {
  const data = readFileSync(inputPath)
  const out = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i += 1) {
    out[i] = data[i] ^ xorKey
  }
  return out
}

export function decryptDatV4(inputPath: string, xorKey: number, aesKey: Buffer): Buffer {
  const bytes = readFileSync(inputPath)
  if (bytes.length < 0x0f) {
    throw new Error('文件太小，无法解析')
  }

  const header = bytes.subarray(0, 0x0f)
  const data = bytes.subarray(0x0f)
  const aesSize = bytesToInt32(header.subarray(6, 10))
  const xorSize = bytesToInt32(header.subarray(10, 14))

  // AES 数据需要对齐到 16 字节（PKCS7 填充）
  // 当 aesSize % 16 === 0 时，仍需要额外 16 字节的填充
  const remainder = ((aesSize % 16) + 16) % 16
  const alignedAesSize = aesSize + (16 - remainder)

  if (alignedAesSize > data.length) {
    throw new Error('文件格式异常：AES 数据长度超过文件实际长度')
  }

  const aesData = data.subarray(0, alignedAesSize)
  let unpadded: Buffer = Buffer.alloc(0)
  if (aesData.length > 0) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', aesKey, null)
    decipher.setAutoPadding(false)
    const decrypted = Buffer.concat([decipher.update(aesData), decipher.final()])

    // 使用 PKCS7 填充移除
    unpadded = strictRemovePadding(decrypted)
  }

  const remaining = data.subarray(alignedAesSize)
  if (xorSize < 0 || xorSize > remaining.length) {
    throw new Error('文件格式异常：XOR 数据长度不合法')
  }

  let rawData = Buffer.alloc(0)
  let xoredData = Buffer.alloc(0)
  if (xorSize > 0) {
    const rawLength = remaining.length - xorSize
    if (rawLength < 0) {
      throw new Error('文件格式异常：原始数据长度小于XOR长度')
    }
    rawData = remaining.subarray(0, rawLength)
    const xorData = remaining.subarray(rawLength)
    xoredData = Buffer.alloc(xorData.length)
    for (let i = 0; i < xorData.length; i += 1) {
      xoredData[i] = xorData[i] ^ xorKey
    }
  } else {
    rawData = remaining
    xoredData = Buffer.alloc(0)
  }

  return Buffer.concat([unpadded, rawData, xoredData])
}

export function decryptDatLegacy(
  inputPath: string,
  xorKey: number,
  aesKey: Buffer | null,
  fallbackReason?: string
): DatDecryptOutcome {
  const version = getDatVersion(inputPath)
  if (version === 0) {
    return { data: decryptDatV3(inputPath, xorKey), source: 'ts', fallbackReason }
  }
  if (version === 1) {
    const key = asciiKey16(DEFAULT_V1_AES_KEY)
    return { data: decryptDatV4(inputPath, xorKey, key), source: 'ts', fallbackReason }
  }
  if (!aesKey || aesKey.length !== 16) {
    throw new Error('请到设置配置图片解密密钥')
  }
  return { data: decryptDatV4(inputPath, xorKey, aesKey), source: 'ts', fallbackReason }
}

function detectImageExtensionAt(buffer: Buffer, offset: number): string | null {
  if (buffer.length < offset + 12) return null
  if (buffer[offset] === 0x47 && buffer[offset + 1] === 0x49 && buffer[offset + 2] === 0x46) return '.gif'
  if (buffer[offset] === 0x89 && buffer[offset + 1] === 0x50 && buffer[offset + 2] === 0x4e && buffer[offset + 3] === 0x47) return '.png'
  if (buffer[offset] === 0xff && buffer[offset + 1] === 0xd8 && buffer[offset + 2] === 0xff) return '.jpg'
  if (buffer[offset] === 0x52 && buffer[offset + 1] === 0x49 && buffer[offset + 2] === 0x46 && buffer[offset + 3] === 0x46 &&
    buffer[offset + 8] === 0x57 && buffer[offset + 9] === 0x45 && buffer[offset + 10] === 0x42 && buffer[offset + 11] === 0x50) {
    return '.webp'
  }
  return null
}

export function detectImageExtension(buffer: Buffer): string | null {
  if (buffer.length < 12) return null

  // 检查是否是 wxgf 格式，如果是则跳过头部再检测
  if (buffer[0] === 0x77 && buffer[1] === 0x78 && buffer[2] === 0x67 && buffer[3] === 0x66) {
    // wxgf 格式，尝试在不同偏移位置查找图片签名
    const offsets = [0x10, 0x12, 0x14, 0x18, 0x20, 0xd0, 0x100]
    for (const offset of offsets) {
      if (buffer.length > offset + 12) {
        const ext = detectImageExtensionAt(buffer, offset)
        if (ext) return ext
      }
    }
    // 暴力搜索 JPG 签名 (ff d8 ff)
    for (let i = 4; i < Math.min(buffer.length - 3, 512); i++) {
      if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
        return '.jpg'
      }
    }
    return null
  }

  return detectImageExtensionAt(buffer, 0)
}

export function looksLikeNativeImagePayload(data: Buffer): boolean {
  if (!Buffer.isBuffer(data) || data.length < 4) return false
  if (data.length >= 20 &&
    data[0] === 0x77 && data[1] === 0x78 &&
    data[2] === 0x67 && data[3] === 0x66) {
    return true
  }
  return detectImageExtension(data) !== null
}
