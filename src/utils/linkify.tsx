import React from 'react'

let tldPattern = ''
let urlRegex: RegExp | null = null

function buildUrlRegex(tlds: string): RegExp {
  return new RegExp(
    `(https?:\\/\\/[^\\s<>"'{}|\\\\^\`\\[\\]]+` +
    `|www\\.[a-zA-Z0-9][-a-zA-Z0-9]*(?:\\.[a-zA-Z0-9][-a-zA-Z0-9]*)*\\.[a-zA-Z]{2,}(?:[/?#][^\\s<>"'{}|\\\\^\`\\[\\]]*)?` +
    `|[a-zA-Z0-9][-a-zA-Z0-9]*(?:\\.[a-zA-Z0-9][-a-zA-Z0-9]*)*\\.(?:${tlds})(?:[/?#][^\\s<>"'{}|\\\\^\`\\[\\]]*)?)`,
    'gi'
  )
}

// 从 IANA 获取 TLD 列表并缓存
async function fetchTldFromIana(): Promise<string[] | null> {
  try {
    const response = await fetch('https://data.iana.org/TLD/tlds-alpha-by-domain.txt')
    if (!response.ok) return null
    
    const text = await response.text()
    const lines = text.split('\n')
      .filter(line => line && !line.startsWith('#'))
      .map(line => line.toLowerCase().trim())
      .filter(line => line.length > 0)
    
    return lines.length > 100 ? lines : null
  } catch (e) {
    console.warn('获取 IANA TLD 列表失败')
    return null
  }
}

// 初始化 TLD 列表（从缓存读取，无缓存则获取并存储）
export async function initTldList(): Promise<void> {
  try {
    // 从数据库读取缓存的 TLD 列表
    const cached = await window.electronAPI.config.getTldCache()
    
    // 如果有缓存，直接使用
    if (cached && cached.tlds.length > 100) {
      // 按长度降序排序，确保长 TLD 优先匹配（如 top 优先于 to）
      const sortedTlds = [...cached.tlds].sort((a, b) => b.length - a.length)
      tldPattern = sortedTlds.join('|')
      urlRegex = buildUrlRegex(tldPattern)
      console.log(`使用缓存的 TLD 列表，共 ${cached.tlds.length} 个`)
      return
    }
    
    // 无缓存，从 IANA 获取
    const freshTlds = await fetchTldFromIana()
    if (freshTlds) {
      // 按长度降序排序，确保长 TLD 优先匹配
      const sortedTlds = freshTlds.sort((a, b) => b.length - a.length)
      tldPattern = sortedTlds.join('|')
      urlRegex = buildUrlRegex(tldPattern)
      // 保存到数据库（保存原始列表，排序在使用时进行）
      await window.electronAPI.config.setTldCache(freshTlds)
      console.log(`TLD 列表已获取并缓存，共 ${freshTlds.length} 个`)
    }
  } catch (e) {
    console.warn('初始化 TLD 列表失败，使用内置列表')
  }
}

/**
 * 将文本中的URL转换为可点击的链接
 */
export function linkifyText(text: string): React.ReactNode {
  if (!text || !urlRegex) return text
  
  // 重置正则
  urlRegex.lastIndex = 0
  
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null
  
  while ((match = urlRegex.exec(text)) !== null) {
    // 添加匹配前的文本
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    
    const url = match[0]
    // 确保链接有协议前缀
    const href = url.startsWith('http') ? url : `https://${url}`
    
    parts.push(
      <a
        key={match.index}
        href="#"
        className="message-link"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          window.electronAPI.shell.openExternal(href)
        }}
        title={url}
      >
        {url}
      </a>
    )
    
    lastIndex = match.index + url.length
  }
  
  // 添加剩余文本
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }
  
  return parts.length > 0 ? parts : text
}
