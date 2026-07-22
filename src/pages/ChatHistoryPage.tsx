import React, { useEffect, useState } from 'react'
import { useLocation, useParams } from 'react-router-dom'
import { ChatRecordItem } from '../types/models'
import MessageContent from '../components/MessageContent'
import { useTitleBarStore } from '../stores/titleBarStore'
import './ChatHistoryPage.scss'

export default function ChatHistoryPage() {
    const { sessionId, messageId } = useParams<{ sessionId: string; messageId: string }>()
    const location = useLocation()
    const [recordList, setRecordList] = useState<ChatRecordItem[]>([])
    const [loading, setLoading] = useState(true)
    const [title, setTitle] = useState('聊天记录')
    const [error, setError] = useState('')
    const setTitleBarTitle = useTitleBarStore(state => state.setTitle)

    // 标题交给窗口级标题栏（App 渲染），本页只负责把标题写进 store
    useEffect(() => {
        setTitleBarTitle(title)
        return () => setTitleBarTitle(null)
    }, [title, setTitleBarTitle])

    // 简单的 XML 标签内容提取
    const extractXmlValue = (xml: string, tag: string): string => {
        const match = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml)
        return match ? match[1] : ''
    }

    // HTML 实体解码，兼容微信 XML 里的十进制/十六进制数字实体
    const decodeHtmlEntities = (text?: string): string | undefined => {
        if (!text) return text
        const decodeCodePoint = (value: string, radix: 10 | 16, fallback: string): string => {
            const codePoint = Number.parseInt(value, radix)
            if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10FFFF) return fallback
            try {
                return String.fromCodePoint(codePoint)
            } catch {
                return fallback
            }
        }

        return text
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&apos;/g, "'")
            .replace(/&nbsp;/g, ' ')
            .replace(/&#x([0-9a-fA-F]+);/g, (entity, hex) => decodeCodePoint(hex, 16, entity))
            .replace(/&#(\d+);/g, (entity, dec) => decodeCodePoint(dec, 10, entity))
    }

    // 前端兜底解析合并转发聊天记录 (与后端逻辑类似)
    const parseChatHistory = (content: string): ChatRecordItem[] | undefined => {
        try {
            const type = extractXmlValue(content, 'type')
            if (type !== '19') return undefined

            const match = /<recorditem>[\s\S]*?<!\[CDATA\[([\s\S]*?)\]\]>[\s\S]*?<\/recorditem>/.exec(content)
            if (!match) return undefined

            const innerXml = match[1]
            const items: ChatRecordItem[] = []
            // 注意这里要使用 [\\s\\S] 而不是写错成 [\\s\\\\s]
            const itemRegex = /<dataitem\s+(.*?)>([\s\S]*?)<\/dataitem>/g
            let itemMatch: RegExpExecArray | null

            while ((itemMatch = itemRegex.exec(innerXml)) !== null) {
                const attrs = itemMatch[1]
                const body = itemMatch[2]

                const datatypeMatch = /datatype="(\d+)"/.exec(attrs)
                const datatype = datatypeMatch ? parseInt(datatypeMatch[1]) : 0

                const sourcename = extractXmlValue(body, 'sourcename')
                const sourcetime = extractXmlValue(body, 'sourcetime')
                const sourceheadurl = extractXmlValue(body, 'sourceheadurl')
                const datadesc = extractXmlValue(body, 'datadesc')
                const datatitle = extractXmlValue(body, 'datatitle')
                const fileext = extractXmlValue(body, 'fileext')
                const datasize = parseInt(extractXmlValue(body, 'datasize') || '0')
                const messageuuid = extractXmlValue(body, 'messageuuid')

                const dataurl = extractXmlValue(body, 'dataurl')
                const datathumburl = extractXmlValue(body, 'datathumburl') || extractXmlValue(body, 'thumburl')
                const datacdnurl = extractXmlValue(body, 'datacdnurl') || extractXmlValue(body, 'cdnurl')
                const aeskey = extractXmlValue(body, 'aeskey') || extractXmlValue(body, 'qaeskey')
                const md5 = extractXmlValue(body, 'md5') || extractXmlValue(body, 'datamd5')
                const imgheight = parseInt(extractXmlValue(body, 'imgheight') || '0')
                const imgwidth = parseInt(extractXmlValue(body, 'imgwidth') || '0')
                const duration = parseInt(extractXmlValue(body, 'duration') || '0')

                items.push({
                    datatype,
                    sourcename,
                    sourcetime,
                    sourceheadurl,
                    datadesc: decodeHtmlEntities(datadesc),
                    datatitle: decodeHtmlEntities(datatitle),
                    fileext,
                    datasize,
                    messageuuid,
                    dataurl: decodeHtmlEntities(dataurl),
                    datathumburl: decodeHtmlEntities(datathumburl),
                    datacdnurl: decodeHtmlEntities(datacdnurl),
                    aeskey: decodeHtmlEntities(aeskey),
                    md5,
                    imgheight,
                    imgwidth,
                    duration
                })
            }

            return items.length > 0 ? items : undefined
        } catch (e) {
            console.error('前端解析聊天记录失败:', e)
            return undefined
        }
    }

    // 统一从路由参数或 pathname 中解析 sessionId / messageId
    const getIds = () => {
        if (sessionId && messageId) {
            return { sid: sessionId, mid: messageId }
        }
        // 独立窗口场景下没有 Route 包裹，用 pathname 手动解析
        const match = /^\/chat-history\/([^/]+)\/([^/]+)/.exec(location.pathname)
        if (match) {
            return { sid: match[1], mid: match[2] }
        }
        return { sid: '', mid: '' }
    }

    useEffect(() => {
        const loadData = async () => {
            const { sid, mid } = getIds()
            if (!sid || !mid) {
                setError('无效的聊天记录链接')
                setLoading(false)
                return
            }
            try {
                const result = await window.electronAPI.chat.getMessage(sid, parseInt(mid, 10))
                if (result.success && result.message) {
                    const msg = result.message
                    // 优先使用后端解析好的列表
                    let records: ChatRecordItem[] | undefined = msg.chatRecordList

                    // 如果后端没有解析到，则在前端兜底解析一次
                    if ((!records || records.length === 0) && msg.rawContent) {
                        records = parseChatHistory(msg.rawContent) || []
                    }

                    if (records && records.length > 0) {
                        setRecordList(records)
                        const match = /<title>(.*?)<\/title>/.exec(msg.rawContent || '')
                        if (match) setTitle(match[1])
                    } else {
                        setError('暂时无法解析这条聊天记录')
                    }
                } else {
                    setError(result.error || '获取消息失败')
                }
            } catch (e) {
                console.error(e)
                setError('加载详情失败')
            } finally {
                setLoading(false)
            }
        }
        loadData()
    }, [sessionId, messageId])

    return (
        <div className="chat-history-page">
            <div className="history-list">
                {loading ? (
                    <div className="status-msg">加载中...</div>
                ) : error ? (
                    <div className="status-msg error">{error}</div>
                ) : recordList.length === 0 ? (
                    <div className="status-msg empty">暂无可显示的聊天记录</div>
                ) : (
                    recordList.map((item, i) => (
                        <HistoryItem key={i} item={item} />
                    ))
                )}
            </div>
        </div>
    )
}

function HistoryItem({ item }: { item: ChatRecordItem }) {
    // sourcetime 在合并转发里有两种格式：
    // 1) 时间戳（秒） 2) 已格式化的字符串 "2026-01-21 09:56:46"
    let time = ''
    if (item.sourcetime) {
        if (/^\d+$/.test(item.sourcetime)) {
            time = new Date(parseInt(item.sourcetime, 10) * 1000).toLocaleString()
        } else {
            time = item.sourcetime
        }
    }

    const renderContent = () => {
        if (item.datatype === 1) {
            return <MessageContent content={item.datadesc || ''} />
        }
        if (item.datatype === 3) {
            // Image
            const src = item.datathumburl || item.datacdnurl
            if (src) {
                return (
                    <div className="media-content">
                        <img src={src} alt="图片" referrerPolicy="no-referrer" onError={(e) => {
                            const target = e.target as HTMLImageElement;
                            target.style.display = 'none';
                            target.parentElement?.insertAdjacentHTML('beforeend', '<div class="media-tip">图片无法加载</div>');
                        }} />
                    </div>
                )
            }
            return <div className="media-placeholder">[图片]</div>
        }
        if (item.datatype === 43) {
            return <div className="media-placeholder">[视频] {item.datatitle}</div>
        }
        if (item.datatype === 34) {
            return <div className="media-placeholder">[语音] {item.duration ? (item.duration / 1000).toFixed(0) + '"' : ''}</div>
        }
        // Fallback
        return <div className="text-content">{item.datadesc || item.datatitle || '[不支持的消息类型]'}</div>
    }

    return (
        <div className="history-item">
            <div className="avatar">
                {item.sourceheadurl ? (
                    <img src={item.sourceheadurl} alt="" referrerPolicy="no-referrer" />
                ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: '12px' }}>
                        {item.sourcename?.slice(0, 1)}
                    </div>
                )}
            </div>
            <div className="content-wrapper">
                <div className="header">
                    <span className="sender">{item.sourcename || '未知发送者'}</span>
                    <span className="time">{time}</span>
                </div>
                <div className={`bubble ${item.datatype === 3 ? 'image-bubble' : ''}`}>
                    {renderContent()}
                </div>
            </div>
        </div>
    )
}
