import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { CircleDashed, CircleExclamation } from '@gravity-ui/icons'
import { Qwen } from '@lobehub/icons'
import { checkOnlineSttConfigReady } from '../../utils/sttConfig'
import { globalVoiceManager } from './mediaState'
import type { ChatSession, Message } from '../../../../types/models'

interface VoiceBubbleProps {
  message: Message
  session: ChatSession
  isSent: boolean
  onContextMenu?: (e: React.MouseEvent, message: Message, handlers?: any) => void
}

/**
 * 语音消息气泡（localType === 34）
 * 支持语音播放、STT 语音转文字、缓存转写结果
 */
function VoiceBubble({ message, session, isSent, onContextMenu }: VoiceBubbleProps) {
  const [voiceLoading, setVoiceLoading] = useState(false)
  const [voicePlaying, setVoicePlaying] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [voiceDataUrl, setVoiceDataUrl] = useState<string | null>(null)
  const voiceRef = useRef<HTMLAudioElement>(null)

  // STT 状态
  const [sttTranscript, setSttTranscript] = useState<string | null>(null)
  const [sttLoading, setSttLoading] = useState(false)
  const [sttError, setSttError] = useState<string | null>(null)
  const [sttProvider, setSttProvider] = useState<'aliyun-qwen-asr' | 'qianwen-cloud' | null>(null)
  const [isEditingStt, setIsEditingStt] = useState(false)
  const [editContent, setEditContent] = useState('')

  const duration = message.voiceDuration || 0
  const displayDuration = duration > 0 ? `${Math.round(duration)}"` : ''
  const minWidth = 60
  const maxWidth = 200
  const width = Math.min(maxWidth, Math.max(minWidth, minWidth + duration * 10))

  // 语音播放处理
  const handlePlayVoice = useCallback(async () => {
    if (voiceLoading) return

    if (voiceDataUrl && voiceRef.current) {
      if (voicePlaying) {
        voiceRef.current.pause()
        setVoicePlaying(false)
        globalVoiceManager.stop(voiceRef.current)
      } else {
        voiceRef.current.currentTime = 0
        globalVoiceManager.play(voiceRef.current, () => {
          voiceRef.current?.pause()
          setVoicePlaying(false)
        })
        voiceRef.current.play()
        setVoicePlaying(true)
      }
      return
    }

    setVoiceLoading(true)
    setVoiceError(null)
    try {
      const result = await window.electronAPI.chat.getVoiceData(session.username, String(message.localId), message.createTime, message.serverId)
      if (result.success && result.data) {
        const dataUrl = `data:audio/wav;base64,${result.data}`
        setVoiceDataUrl(dataUrl)
        requestAnimationFrame(() => {
          if (voiceRef.current) {
            globalVoiceManager.play(voiceRef.current, () => {
              voiceRef.current?.pause()
              setVoicePlaying(false)
            })
            voiceRef.current.play()
            setVoicePlaying(true)
          }
        })
      } else {
        setVoiceError(result.error || '加载失败')
      }
    } catch (e) {
      setVoiceError(String(e))
    } finally {
      setVoiceLoading(false)
    }
  }, [voiceLoading, voiceDataUrl, voicePlaying, session.username, message.localId, message.createTime, message.serverId])

  // 语音播放结束
  const handleVoiceEnded = useCallback(() => {
    setVoicePlaying(false)
    if (voiceRef.current) globalVoiceManager.stop(voiceRef.current)
  }, [])

  // 语音转文字处理
  const handleTranscribeVoice = useCallback(async (e?: React.MouseEvent, force = false) => {
    e?.stopPropagation()

    if (sttLoading || (sttTranscript && !force)) return

    console.log('[STT] 开始转写...')
    setSttLoading(true)
    setSttError(null)

    try {
      // 防重复：先查转写结果缓存，命中则直接复用，避免重复检查模型状态与初始化引擎
      if (!force) {
        try {
          const cached = await window.electronAPI.stt.getCachedTranscript(session.username, message.createTime, message.localId)
          if (cached.success && cached.transcript) {
            setSttTranscript(cached.transcript)
            setSttLoading(false)
            return
          }
        } catch {
          // 缓存查询失败则继续正常转写流程
        }
      }

      const sttMode = await window.electronAPI.config.get('sttMode') || 'cpu'
      console.log('[STT] 当前模式:', sttMode)

      let modelExists = false
      let modelName = ''

      if (sttMode === 'gpu') {
        setSttProvider(null)
        const whisperModelType = (await window.electronAPI.config.get('whisperModelType') as string) || 'small'
        console.log('[ChatPage] 读取到的 Whisper 模型类型:', whisperModelType)

        const modelStatus = await window.electronAPI.sttWhisper.checkModel(whisperModelType)
        modelExists = modelStatus.exists
        modelName = `Whisper ${whisperModelType}`

        if (!modelExists) {
          if (window.confirm(`Whisper ${whisperModelType} 模型未下载，是否立即下载？\n下载完成后将自动开始转写。`)) {
            setSttLoading(true)
            setSttTranscript('准备下载模型...')

            const removeProgress = window.electronAPI.sttWhisper.onDownloadProgress((p) => {
              const pct = p.percent || 0
              setSttTranscript(`正在下载模型... ${pct.toFixed(1)}%`)
            })

            try {
              const dlResult = await window.electronAPI.sttWhisper.downloadModel(whisperModelType)
              removeProgress()

              if (dlResult.success) {
                setSttTranscript('模型下载完成，正在初始化引擎...')
                await new Promise(r => setTimeout(r, 2000))
                setSttLoading(false)
                await handleTranscribeVoice(undefined, true)
                return
              } else {
                setSttError(dlResult.error || '模型下载失败')
                setSttTranscript(null)
              }
            } catch (e) {
              removeProgress()
              setSttError(`模型下载出错: ${e}`)
              setSttTranscript(null)
            }
          }
          setSttLoading(false)
          return
        }
      } else if (sttMode === 'online') {
        const onlineReady = await checkOnlineSttConfigReady()
        modelExists = onlineReady.ready
        const onlineProvider = await window.electronAPI.config.get('sttOnlineProvider')
        setSttProvider(
          onlineProvider === 'aliyun-qwen-asr' || onlineProvider === 'qianwen-cloud'
            ? onlineProvider as 'aliyun-qwen-asr' | 'qianwen-cloud'
            : null
        )
        modelName = onlineProvider === 'aliyun-qwen-asr'
          ? '阿里云 Qwen-ASR'
          : onlineProvider === 'qianwen-cloud'
            ? '千问云'
            : onlineProvider === 'volcano-doubao'
              ? '火山豆包'
              : onlineProvider === 'custom'
                ? '自定义在线接口'
                : 'OpenAI 兼容在线转写'

        if (!modelExists) {
          setSttError(onlineReady.error || '在线转写配置不完整，请先到设置页补齐')
          setSttLoading(false)
          return
        }
      } else {
        setSttProvider(null)
        const modelStatus = await window.electronAPI.stt.getModelStatus()
        modelExists = !!(modelStatus.success && modelStatus.exists)
        modelName = 'SenseVoice'

        if (!modelExists) {
          if (window.confirm('语音识别模型未下载，是否立即下载？(约245MB)\n下载完成后将自动开始转写。')) {
            setSttLoading(true)
            setSttTranscript('准备下载模型...')

            const removeProgress = window.electronAPI.stt.onDownloadProgress((p) => {
              const pct = p.percent || 0
              setSttTranscript(`正在下载模型... ${pct.toFixed(1)}%`)
            })

            try {
              const dlResult = await window.electronAPI.stt.downloadModel()
              removeProgress()

              if (dlResult.success) {
                setSttTranscript('模型下载完成，正在初始化引擎...')
                await new Promise(r => setTimeout(r, 2000))
                setSttLoading(false)
                await handleTranscribeVoice(undefined, true)
                return
              } else {
                setSttError(dlResult.error || '模型下载失败')
                setSttTranscript(null)
              }
            } catch (e) {
              removeProgress()
              setSttError(`模型下载出错: ${e}`)
              setSttTranscript(null)
            }
          }
          setSttLoading(false)
          return
        }
      }

      console.log('[STT] 模型已就绪:', modelName)

      let wavBase64 = voiceDataUrl?.replace('data:audio/wav;base64,', '')

      if (!wavBase64) {
        console.log('[STT] 获取语音数据...')
        const result = await window.electronAPI.chat.getVoiceData(
          session.username,
          String(message.localId),
          message.createTime,
          message.serverId
        )
        console.log('[STT] 语音数据:', { success: result.success, dataLength: result.data?.length })
        if (!result.success || !result.data) {
          setSttError(result.error || '获取语音数据失败')
          setSttLoading(false)
          return
        }
        wavBase64 = result.data
        setVoiceDataUrl(`data:audio/wav;base64,${wavBase64}`)
      }

      let removeListener: (() => void) | undefined
      if (sttMode === 'cpu' || sttMode === 'online') {
        removeListener = window.electronAPI.stt.onPartialResult((text) => {
          setSttTranscript(text)
        })
      }

      const result = await window.electronAPI.stt.transcribe(wavBase64, session.username, message.createTime, force, message.localId)
      removeListener?.()

      if (result.success && result.transcript) {
        setSttTranscript(result.transcript)
      } else if (result.success && result.cached) {
        setSttError('转写结果为空（已缓存，右键可重新转写）')
      } else {
        setSttError(result.error || '转写失败')
      }
    } catch (e) {
      console.error('[STT] 转写异常:', e)
      setSttError(String(e))
    } finally {
      setSttLoading(false)
    }
  }, [sttLoading, sttTranscript, voiceDataUrl, session.username, message.localId, message.createTime, checkOnlineSttConfigReady])

  // 自动检查转写缓存
  useEffect(() => {
    if (sttTranscript || sttLoading) return

    window.electronAPI.stt.getCachedTranscript(session.username, message.createTime, message.localId).then((result) => {
      if (result.success && result.transcript) {
        setSttTranscript(result.transcript)
      }
    }).catch(() => {
    })
  }, [session.username, message.createTime, sttTranscript, sttLoading])

  // 语音图标组件
  const VoiceIcon = () => {
    if (voiceLoading) {
      return <CircleDashed width={18} height={18} className="spin" />
    }
    if (voiceError) {
      return <CircleExclamation width={18} height={18} className="voice-error-icon" />
    }
    if (voicePlaying) {
      return (
        <div className={`voice-waves ${isSent ? 'sent' : ''}`}>
          <span></span>
          <span></span>
          <span></span>
        </div>
      )
    }
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
    )
  }

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (onContextMenu) {
      onContextMenu(e, message, {
        reTranscribe: () => handleTranscribeVoice(undefined, true),
        editStt: sttTranscript ? () => {
          setEditContent(sttTranscript)
          setIsEditingStt(true)
        } : undefined
      })
    }
  }, [onContextMenu, message, handleTranscribeVoice, sttTranscript])

  return (
    <div className="voice-bubble-container" onContextMenu={handleContextMenu}>
      <div
        className="bubble-content voice-bubble"
        style={{ minWidth: `${width}px` }}
        onClick={handlePlayVoice}
      >
        <div
          className={`voice-message ${voicePlaying ? 'playing' : ''} ${voiceError ? 'error' : ''} ${isSent ? 'sent' : ''}`}
        >
          {isSent ? (
            <>
              <span className="voice-duration">{displayDuration}</span>
              <div className="voice-icon"><VoiceIcon /></div>
            </>
          ) : (
            <>
              <div className="voice-icon"><VoiceIcon /></div>
              <span className="voice-duration">{displayDuration}</span>
            </>
          )}
          {voiceDataUrl && (
            <audio
              ref={voiceRef}
              src={voiceDataUrl}
              onEnded={handleVoiceEnded}
              onError={() => setVoiceError('播放失败')}
            />
          )}
        </div>
      </div>

      {/* 转文字按钮或转写结果 */}
      {sttTranscript ? (
        isEditingStt ? (
          <div className="stt-edit-container" onClick={e => e.stopPropagation()}>
            <textarea
              className="stt-edit-textarea"
              value={editContent}
              onChange={e => setEditContent(e.target.value)}
              autoFocus
              onContextMenu={e => e.stopPropagation()}
            />
            <div className="stt-edit-actions">
              <button
                className="stt-edit-btn cancel"
                onClick={(e) => {
                  e.stopPropagation()
                  setIsEditingStt(false)
                }}
              >
                取消
              </button>
              <button
                className="stt-edit-btn save"
                onClick={async (e) => {
                  e.stopPropagation()
                  if (editContent.trim() !== sttTranscript) {
                    setSttTranscript(editContent)
                    try {
                      await window.electronAPI.stt.updateTranscript(session.username, message.createTime, editContent, message.localId)
                    } catch (err) {
                      console.error('更新转写缓存失败:', err)
                    }
                  }
                  setIsEditingStt(false)
                }}
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <div className="stt-transcript" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>{sttTranscript}</span>
            {sttLoading && <CircleDashed width={12} height={12} className="spin" style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />}
          </div>
        )
      ) : (
        <button
          className={`stt-button ${sttLoading ? 'loading' : ''} ${sttError ? 'error' : ''}`}
          onClick={handleTranscribeVoice}
          disabled={sttLoading}
          title={sttError || '点击转文字'}
        >
          {sttLoading ? (
            (sttProvider === 'aliyun-qwen-asr' || sttProvider === 'qianwen-cloud') ? (
              <Qwen.Color className="stt-provider-loading-icon" width={18} height={18} />
            ) : (
              <CircleDashed width={12} height={12} className="spin" />
            )
          ) : sttError ? (
            <CircleExclamation width={12} height={12} />
          ) : (
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7V4h16v3" />
              <path d="M9 20h6" />
              <path d="M12 4v16" />
            </svg>
          )}
          {((sttProvider !== 'aliyun-qwen-asr' && sttProvider !== 'qianwen-cloud') || !sttLoading) && (
            <span>{sttLoading ? '转写中' : sttError ? '重试' : '转文字'}</span>
          )}
        </button>
      )}
      {sttError && (
        <div className="stt-error-msg" style={{ fontSize: '11px', color: '#ff4d4f', marginTop: '4px', marginLeft: '4px' }}>
          {sttError}
        </div>
      )}
    </div>
  )
}

function areVoiceBubblePropsEqual(prev: VoiceBubbleProps, next: VoiceBubbleProps) {
  return prev.message === next.message &&
    prev.session === next.session &&
    prev.isSent === next.isSent
}

export default memo(VoiceBubble, areVoiceBubblePropsEqual)
