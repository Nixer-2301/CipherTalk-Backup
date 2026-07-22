import { useEffect, useState } from 'react'
import { Button, Chip, Modal, Spinner, toast } from '@heroui/react'

type WechatStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

const STATUS_TEXT: Record<WechatStatus, string> = {
  disconnected: '未连接',
  connecting: '等待扫码',
  connected: '已连接',
  error: '连接异常',
}

const WECHAT_LOGO_SRC = './微信logo.png'
const CIPHERTALK_LOGO_SRC = './logo.png'

/**
 * 设备连接弹窗 —— 单一卡片弹窗，目前只有微信扫码连接。
 * 二维码内嵌在同一弹窗里，不再单独开页面/嵌套弹窗。
 */
export function DeviceConnectDialog({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [status, setStatus] = useState<WechatStatus>('disconnected')
  const [error, setError] = useState<string | null>(null)
  const [qrcodeImage, setQrcodeImage] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const api = window.electronAPI.deviceConnect.wechat
    api.getStatus().then((s) => { setStatus(s.status); setError(s.error) }).catch(() => undefined)

    const offStatus = api.onStatus((s) => {
      setStatus(s.status)
      setError(s.error)
      if (s.status === 'connected') {
        setConnecting(false)
        setQrcodeImage(null)
        setScanned(false)
      }
    })
    const offQrcode = api.onQrcode((p) => { setQrcodeImage(p.qrcodeImage); setScanned(false) })
    const offScan = api.onScanState((p) => {
      if (p.state === 'scaned') setScanned(true)
      else if (p.state === 'failed') { setScanned(false); if (p.error) toast.danger(p.error) }
    })
    return () => { offStatus(); offQrcode(); offScan() }
  }, [])

  const handleConnect = async () => {
    setBusy(true)
    setScanned(false)
    setQrcodeImage(null)
    setConnecting(true)
    try {
      const res = await window.electronAPI.deviceConnect.wechat.connect()
      if (!res.success) {
        toast.danger(res.error || '获取二维码失败')
        setConnecting(false)
      } else if (res.qrcodeImage) {
        setQrcodeImage(res.qrcodeImage)
      }
    } catch (e) {
      toast.danger(e instanceof Error ? e.message : '连接失败')
      setConnecting(false)
    } finally {
      setBusy(false)
    }
  }

  const cancelConnecting = async () => {
    setConnecting(false)
    setQrcodeImage(null)
    setScanned(false)
    await window.electronAPI.deviceConnect.wechat.cancel().catch(() => undefined)
  }

  const handleDisconnect = async () => {
    setBusy(true)
    try {
      await window.electronAPI.deviceConnect.wechat.disconnect()
      toast.success('已断开微信连接')
    } finally {
      setBusy(false)
    }
  }

  const handleClose = () => {
    if (connecting) void cancelConnecting()
    onClose()
  }

  const statusColor = status === 'connected' ? 'success' : status === 'error' ? 'danger' : undefined

  return (
    <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) handleClose() }}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>设备连接</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <div className="flex flex-col gap-4 pb-2">
                <div className="flex items-center gap-3">
                  <div className="flex size-12 shrink-0 items-center justify-center p-1">
                    <img src={WECHAT_LOGO_SRC} alt="微信" className="h-full w-full object-contain" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-base font-semibold text-foreground">微信</span>
                      <Chip size="sm" variant="soft" color={statusColor}>{STATUS_TEXT[status]}</Chip>
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {status === 'connected' ? '消息会自动交给 AI 助手处理并回复' : '扫码连接，让 AI 助手直接在微信收发消息'}
                    </p>
                  </div>
                </div>

                {error && status === 'error' && <p className="text-xs text-danger">{error}</p>}

                {connecting ? (
                  <div className="flex flex-col items-center gap-4 py-2">
                    <div className="relative flex size-60 items-center justify-center rounded-xl bg-white">
                      {qrcodeImage ? (
                        <>
                          <img src={qrcodeImage} alt="微信连接二维码" className="size-60 rounded-xl" />
                          <img src={CIPHERTALK_LOGO_SRC} alt="" className="pointer-events-none absolute size-10 rounded-lg" />
                        </>
                      ) : (
                        <Spinner />
                      )}
                    </div>
                    <p className="text-sm text-muted">
                      {scanned ? '已扫码，请在手机微信上点击确认' : '请用手机微信扫描二维码以连接'}
                    </p>
                    <Button variant="tertiary" fullWidth onPress={() => void cancelConnecting()}>取消扫码</Button>
                  </div>
                ) : status === 'connected' ? (
                  <Button variant="tertiary" fullWidth isDisabled={busy} onPress={handleDisconnect}>断开连接</Button>
                ) : (
                  <Button variant="primary" fullWidth isDisabled={busy} onPress={handleConnect}>连接微信</Button>
                )}
              </div>
            </Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export default DeviceConnectDialog
