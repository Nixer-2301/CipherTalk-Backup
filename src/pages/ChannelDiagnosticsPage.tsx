/**
 * ChannelDiagnosticsPage
 *
 * 数据通道诊断页（骨架）
 *
 * TODO(direct-db): Wave D 会将本页接入 window.electronAPI.wcdb.open /
 * wcdb.testConnection / wcdb.onChange，用于实时展示直连数据库的连接状态、
 * 监听 WCDB 文件变化并反映给用户。
 *
 * 本轮（T14）只提供一个静态骨架，不接 router，不改 App.tsx，不引入新依赖。
 */
import React from 'react'

const PLACEHOLDER = '待接入'

const ChannelDiagnosticsPage: React.FC = () => {
  // 占位：Wave D 会用 useState + wcdb.onChange 订阅实时状态
  const dbPath = PLACEHOLDER
  const wxid = PLACEHOLDER
  const connectionStatus = PLACEHOLDER

  return (
    <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif' }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>数据通道诊断</h1>

      <p style={{ color: '#666', marginBottom: 24 }}>
        此页为 Wave D 预留的诊断入口，当前仅显示占位数据。
      </p>

      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, padding: 16 }}>
        <div style={{ marginBottom: 8 }}>
          <strong>数据库路径：</strong>
          <span style={{ marginLeft: 8, color: '#444' }}>{dbPath}</span>
        </div>
        <div style={{ marginBottom: 8 }}>
          <strong>wxid：</strong>
          <span style={{ marginLeft: 8, color: '#444' }}>{wxid}</span>
        </div>
        <div>
          <strong>连接状态：</strong>
          <span style={{ marginLeft: 8, color: '#444' }}>{connectionStatus}</span>
        </div>
      </div>

      <p style={{ marginTop: 24, fontSize: 12, color: '#999' }}>
        Wave D 将替换此处占位为实时 wcdb.onChange 事件流。
      </p>
    </div>
  )
}

export default ChannelDiagnosticsPage
