import { useEffect } from 'react'
import { ArrowsRotateLeft, CircleCheck, CircleExclamation, Clock, Key } from '@gravity-ui/icons'
import { useActivationStore } from '../../../stores/activationStore'

function getTypeDisplayName(type: string | null) {
  if (!type) return '未激活'
  const typeMap: Record<string, string> = {
    '30days': '30天试用版',
    '90days': '90天标准版',
    '365days': '365天专业版',
    'permanent': '永久版'
  }
  return typeMap[type] || type
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return '永久'
  return new Date(dateStr).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

function ActivationTab() {
  const { status: activationStatus, checkStatus: checkActivationStatus } = useActivationStore()

  // 进入激活 tab 时自动刷新状态
  useEffect(() => {
    checkActivationStatus()
  }, [])

  return (
    <div className="tab-content activation-tab">
      <div className={`activation-status-card ${activationStatus?.isActivated ? 'activated' : 'inactive'}`}>
        <div className="status-icon">
          {activationStatus?.isActivated ? (
            <CircleCheck width={48} height={48} />
          ) : (
            <CircleExclamation width={48} height={48} />
          )}
        </div>
        <div className="status-content">
          <h3>{activationStatus?.isActivated ? '已激活' : '未激活'}</h3>
          {activationStatus?.isActivated && (
            <>
              <p className="status-type">{getTypeDisplayName(activationStatus.type)}</p>
              {activationStatus.daysRemaining !== null && activationStatus.type !== 'permanent' && (
                <p className="status-expires">
                  <Clock width={14} height={14} />
                  {activationStatus.daysRemaining > 0
                    ? `剩余 ${activationStatus.daysRemaining} 天`
                    : '已过期'}
                </p>
              )}
              {activationStatus.expiresAt && (
                <p className="status-date">到期时间：{formatDate(activationStatus.expiresAt)}</p>
              )}
              {activationStatus.activatedAt && (
                <p className="status-date">激活时间：{formatDate(activationStatus.activatedAt)}</p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="device-info-card">
        <h4>设备信息</h4>
        <div className="device-id-row">
          <span className="label">设备标识：</span>
          <code>{activationStatus?.deviceId || '获取中...'}</code>
        </div>
      </div>

      <div className="activation-actions">
        <button className="btn btn-secondary" onClick={() => checkActivationStatus()}>
          <ArrowsRotateLeft width={16} height={16} /> 刷新状态
        </button>
        <button className="btn btn-primary" onClick={() => window.electronAPI.window.openPurchaseWindow()}>
          <Key width={16} height={16} /> 获取激活码
        </button>
      </div>
    </div>
  )
}

export default ActivationTab
