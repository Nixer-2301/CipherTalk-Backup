import { useState, useEffect } from 'react'
import { Check, CircleCheck, CircleDashed, CircleExclamation, Clock, Copy, Key, Shield } from '@gravity-ui/icons'
import type { ActivationStatus } from '../types/electron'
import './ActivationPage.scss'

interface ActivationPageProps {
  onActivated?: () => void
  showBackButton?: boolean
  onBack?: () => void
}

export default function ActivationPage({ onActivated, showBackButton, onBack }: ActivationPageProps) {
  const [activationCode, setActivationCode] = useState('')
  const [status, setStatus] = useState<ActivationStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [activating, setActivating] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  const [deviceIdCopied, setDeviceIdCopied] = useState(false)

  useEffect(() => {
    checkActivationStatus()
  }, [])

  const checkActivationStatus = async () => {
    setLoading(true)
    try {
      const result = await window.electronAPI.activation.checkStatus()
      setStatus(result)
    } catch (e) {
      console.error('检查激活状态失败:', e)
    } finally {
      setLoading(false)
    }
  }

  const handleActivate = async () => {
    if (!activationCode.trim()) {
      setMessage({ type: 'error', text: '请输入激活码' })
      return
    }

    setActivating(true)
    setMessage(null)

    try {
      const result = await window.electronAPI.activation.activate(activationCode.trim())
      
      if (result.success) {
        setMessage({ type: 'success', text: '激活成功！' })
        setActivationCode('')
        await checkActivationStatus()
        onActivated?.()
      } else {
        setMessage({ type: 'error', text: result.message })
      }
    } catch (e) {
      setMessage({ type: 'error', text: '激活失败，请检查网络连接' })
    } finally {
      setActivating(false)
    }
  }

  const copyDeviceId = async () => {
    if (status?.deviceId) {
      await navigator.clipboard.writeText(status.deviceId)
      setDeviceIdCopied(true)
      setTimeout(() => setDeviceIdCopied(false), 2000)
    }
  }

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '永久'
    return new Date(dateStr).toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
  }

  const getTypeDisplayName = (type: string | null) => {
    if (!type) return '未激活'
    const typeMap: Record<string, string> = {
      '30days': '30天试用版',
      '90days': '90天标准版',
      '365days': '365天专业版',
      'permanent': '永久版'
    }
    return typeMap[type] || type
  }

  if (loading) {
    return (
      <div className="activation-page">
        <div className="activation-loading">
          <CircleDashed className="spin" width={48} height={48} />
          <p>正在检查激活状态...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="activation-page">
      <div className="activation-container">
        {showBackButton && onBack && (
          <button className="back-button" onClick={onBack}>
            ← 返回
          </button>
        )}

        <div className="activation-header">
          <Shield width={64} height={64} className="shield-icon" />
          <h1>软件激活</h1>
          <p>请输入激活码以解锁全部功能</p>
        </div>

        {/* 当前状态卡片 */}
        <div className={`status-card ${status?.isActivated ? 'activated' : 'inactive'}`}>
          <div className="status-icon">
            {status?.isActivated ? (
              <CircleCheck width={32} height={32} />
            ) : (
              <CircleExclamation width={32} height={32} />
            )}
          </div>
          <div className="status-info">
            <h3>{status?.isActivated ? '已激活' : '未激活'}</h3>
            {status?.isActivated && (
              <>
                <p className="status-type">{getTypeDisplayName(status.type)}</p>
                {status.daysRemaining !== null && status.type !== 'permanent' && (
                  <p className="status-expires">
                    <Clock width={14} height={14} />
                    {status.daysRemaining > 0 
                      ? `剩余 ${status.daysRemaining} 天` 
                      : '已过期'}
                  </p>
                )}
                {status.expiresAt && (
                  <p className="status-date">到期时间：{formatDate(status.expiresAt)}</p>
                )}
              </>
            )}
          </div>
        </div>

        {/* 激活表单 */}
        {(!status?.isActivated || (status.daysRemaining !== null && status.daysRemaining <= 0)) && (
          <div className="activation-form">
            <div className="input-group">
              <Key width={20} height={20} />
              <input
                type="text"
                placeholder="请输入激活码 (例如: XXXX-XXXX-XXXX-XXXX)"
                value={activationCode}
                onChange={(e) => setActivationCode(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === 'Enter' && handleActivate()}
                disabled={activating}
              />
            </div>

            {message && (
              <div className={`message ${message.type}`}>
                {message.type === 'success' ? <CircleCheck width={16} height={16} /> : <CircleExclamation width={16} height={16} />}
                {message.text}
              </div>
            )}

            <button 
              className="activate-button"
              onClick={handleActivate}
              disabled={activating || !activationCode.trim()}
            >
              {activating ? (
                <>
                  <CircleDashed className="spin" width={18} height={18} />
                  激活中...
                </>
              ) : (
                <>
                  <Shield width={18} height={18} />
                  立即激活
                </>
              )}
            </button>
          </div>
        )}

        {/* 设备信息 */}
        <div className="device-info">
          <p className="device-label">设备标识</p>
          <div className="device-id">
            <code>{status?.deviceId || '获取中...'}</code>
            <button 
              className="copy-button"
              onClick={copyDeviceId}
              title="复制设备ID"
            >
              {deviceIdCopied ? <Check width={14} height={14} /> : <Copy width={14} height={14} />}
            </button>
          </div>
        </div>

        {/* 购买提示 */}
        <div className="purchase-hint">
          <p>还没有激活码？</p>
          <a 
            href="#" 
            onClick={(e) => {
              e.preventDefault()
              window.electronAPI.window.openPurchaseWindow()
            }}
          >
            点击此处获取激活码 →
          </a>
        </div>
      </div>
    </div>
  )
}
