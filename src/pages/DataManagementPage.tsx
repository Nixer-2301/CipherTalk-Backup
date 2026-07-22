/**
 * DataManagementPage
 *
 * 图片 / 表情包缓存查看。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '@heroui/react'
import { ArrowDownToLine, ArrowsRotateLeft, FaceSmile, Picture, TrashBin } from '@gravity-ui/icons'
import './DataManagementPage.css'

type TabType = 'images' | 'emojis'

interface ImageFileInfo {
  fileName: string
  filePath: string
  fileSize: number
  isDecrypted: boolean
  decryptedPath?: string
  version: number
}

const INITIAL_MEDIA_COUNT = 40
const MEDIA_BATCH_SIZE = 40

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function toFileUrl(filePath: string): string {
  return filePath.startsWith('data:') || filePath.startsWith('file://')
    ? filePath
    : `file:///${filePath.replace(/\\/g, '/')}`
}

function DataManagementPage() {
  const [activeTab, setActiveTab] = useState<TabType>('images')
  const [images, setImages] = useState<ImageFileInfo[]>([])
  const [emojis, setEmojis] = useState<ImageFileInfo[]>([])
  const [isMediaLoading, setIsMediaLoading] = useState(false)
  const [mediaLoaded, setMediaLoaded] = useState({ images: false, emojis: false })
  const [displayedImageCount, setDisplayedImageCount] = useState(INITIAL_MEDIA_COUNT)
  const [displayedEmojiCount, setDisplayedEmojiCount] = useState(INITIAL_MEDIA_COUNT)
  const [isDeletingThumbs, setIsDeletingThumbs] = useState(false)
  const [thumbDeleteConfirm, setThumbDeleteConfirm] = useState<{ show: boolean; count: number }>({ show: false, count: 0 })
  const imageGridRef = useRef<HTMLDivElement>(null)
  const emojiGridRef = useRef<HTMLDivElement>(null)

  const showMessage = useCallback((text: string, success: boolean) => {
    if (success) toast.success(text, { timeout: 2500 })
    else toast.danger(text, { timeout: 2500 })
  }, [])

  const loadMedia = useCallback(async (target: TabType) => {
    setIsMediaLoading(true)
    try {
      const dirsResult = await window.electronAPI.dataManagement.getImageDirectories()
      if (!dirsResult.success || !dirsResult.directories?.length) {
        if (target === 'images') setImages([])
        else setEmojis([])
        setMediaLoaded((prev) => ({ ...prev, [target]: true }))
        showMessage(dirsResult.error || '未找到图片或表情包目录', false)
        return
      }

      const mediaDir = dirsResult.directories.find((dir) => {
        const normalized = dir.path.replace(/\\/g, '/').toLowerCase()
        return target === 'images' ? normalized.endsWith('/images') : normalized.endsWith('/emojis')
      })

      if (!mediaDir) {
        if (target === 'images') setImages([])
        else setEmojis([])
        setMediaLoaded((prev) => ({ ...prev, [target]: true }))
        showMessage(target === 'images' ? '未找到图片目录' : '未找到表情包目录', false)
        return
      }

      const result = await window.electronAPI.dataManagement.scanImages(mediaDir.path)
      if (!result.success) {
        showMessage(result.error || '扫描媒体失败', false)
        return
      }

      const files = result.images || []
      if (target === 'images') {
        setImages(files)
        setDisplayedImageCount(INITIAL_MEDIA_COUNT)
      } else {
        setEmojis(files)
        setDisplayedEmojiCount(INITIAL_MEDIA_COUNT)
      }
      setMediaLoaded((prev) => ({ ...prev, [target]: true }))
    } catch (e) {
      showMessage(`扫描媒体失败: ${e}`, false)
    } finally {
      setIsMediaLoading(false)
    }
  }, [showMessage])

  useEffect(() => {
    if (activeTab === 'images' && !mediaLoaded.images) {
      void loadMedia('images')
    } else if (activeTab === 'emojis' && !mediaLoaded.emojis) {
      void loadMedia('emojis')
    }
  }, [activeTab, loadMedia, mediaLoaded])

  const handleMediaScroll = useCallback((target: TabType) => {
    const grid = target === 'images' ? imageGridRef.current : emojiGridRef.current
    if (!grid) return

    const distanceToBottom = grid.scrollHeight - grid.scrollTop - grid.clientHeight
    if (distanceToBottom > 300) return

    if (target === 'images') {
      setDisplayedImageCount((prev) => Math.min(prev + MEDIA_BATCH_SIZE, images.length))
    } else {
      setDisplayedEmojiCount((prev) => Math.min(prev + MEDIA_BATCH_SIZE, emojis.length))
    }
  }, [emojis.length, images.length])

  const handleImageClick = useCallback(async (image: ImageFileInfo) => {
    const imagePath = image.decryptedPath || image.filePath
    try {
      await window.electronAPI.window.openImageViewerWindow(imagePath)
    } catch (e) {
      showMessage(`打开图片失败: ${e}`, false)
    }
  }, [showMessage])

  const handleDownloadImage = useCallback((e: React.MouseEvent, image: ImageFileInfo) => {
    e.stopPropagation()
    const imagePath = image.decryptedPath || image.filePath
    const link = document.createElement('a')
    link.href = toFileUrl(imagePath)
    link.download = image.fileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }, [])

  const handleDeleteThumbnails = useCallback(async () => {
    try {
      const result = await window.electronAPI.image.countThumbnails()
      if (!result.success) {
        showMessage(result.error || '统计缩略图失败', false)
        return
      }

      if (result.count === 0) {
        showMessage('没有可删除的缩略图缓存', true)
        return
      }

      setThumbDeleteConfirm({ show: true, count: result.count })
    } catch (e) {
      showMessage(`统计缩略图失败: ${e}`, false)
    }
  }, [showMessage])

  const confirmDeleteThumbnails = useCallback(async () => {
    setThumbDeleteConfirm({ show: false, count: 0 })
    setIsDeletingThumbs(true)
    try {
      const result = await window.electronAPI.image.deleteThumbnails()
      if (result.success) {
        showMessage(`已删除 ${result.deleted} 张缩略图`, true)
        await loadMedia('images')
      } else {
        showMessage(result.error || '删除缩略图失败', false)
      }
    } catch (e) {
      showMessage(`删除缩略图失败: ${e}`, false)
    } finally {
      setIsDeletingThumbs(false)
    }
  }, [loadMedia, showMessage])

  const renderMediaGrid = (target: TabType) => {
    const list = target === 'images' ? images : emojis
    const displayedCount = target === 'images' ? displayedImageCount : displayedEmojiCount
    const ref = target === 'images' ? imageGridRef : emojiGridRef
    const title = target === 'images' ? '图片管理' : '表情包管理'
    const emptyText = target === 'images' ? '未找到图片文件' : '未找到表情包'
    const Icon = target === 'images' ? Picture : FaceSmile

    return (
      <>
        <div className="media-header">
          <div>
            <h2>{title}</h2>
            <p className="section-desc">
              {isMediaLoading ? '正在扫描...' : `共 ${list.length} 个文件`}
            </p>
          </div>
          <div className="section-actions">
            {target === 'images' && (
              <button className="btn btn-secondary" onClick={() => void handleDeleteThumbnails()} disabled={isDeletingThumbs}>
                <TrashBin width={16} height={16} />
                {isDeletingThumbs ? '删除中...' : '一键删除缩略图'}
              </button>
            )}
            <button className="btn btn-secondary" onClick={() => void loadMedia(target)} disabled={isMediaLoading}>
              <ArrowsRotateLeft width={16} height={16} className={isMediaLoading ? 'spin' : ''} />
              刷新
            </button>
          </div>
        </div>

        <div
          className={`media-grid ${target === 'emojis' ? 'emoji-grid' : ''}`}
          ref={ref}
          onScroll={() => handleMediaScroll(target)}
        >
          {list.slice(0, displayedCount).map((image) => {
            const imagePath = image.decryptedPath || image.filePath
            const imagePathLower = imagePath.toLowerCase()
            const isThumb = /_thumb\./.test(imagePathLower) || /_t\./.test(imagePathLower) || /\.t\./.test(imagePathLower)
            const isHd = /_hd\./.test(imagePathLower) || /_h\./.test(imagePathLower)

            return (
              <div
                key={image.filePath}
                className={`media-item ${target === 'emojis' ? 'emoji-item' : ''}`}
                onClick={() => void handleImageClick(image)}
              >
                {target === 'images' && (
                  <span className={`media-quality-tag ${isThumb ? 'thumb' : 'hd'}`}>
                    {isThumb ? '缩略图' : isHd ? '高清图' : '原图'}
                  </span>
                )}
                <img
                  src={toFileUrl(imagePath)}
                  alt={image.fileName}
                  loading="lazy"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                  }}
                />
                <div className="media-actions">
                  <button
                    className="action-btn download-btn"
                    onClick={(e) => handleDownloadImage(e, image)}
                    title="下载"
                  >
                    <ArrowDownToLine width={16} height={16} />
                  </button>
                </div>
                <div className="media-info">
                  <span className="media-name">{image.fileName}</span>
                  <span className="media-size">{formatFileSize(image.fileSize)}</span>
                </div>
              </div>
            )
          })}

          {!isMediaLoading && list.length === 0 && (
            <div className="empty-state">
              <Icon width={48} height={48} />
              <p>{emptyText}</p>
              <p className="hint">请确认图片缓存目录已生成</p>
            </div>
          )}

          {displayedCount < list.length && (
            <div className="loading-more">
              继续滚动加载 ({displayedCount}/{list.length})
            </div>
          )}
        </div>
      </>
    )
  }

  return (
    <>
      {thumbDeleteConfirm.show && (
        <div className="delete-confirm-overlay" onClick={() => setThumbDeleteConfirm({ show: false, count: 0 })}>
          <div className="delete-confirm-card" onClick={(e) => e.stopPropagation()}>
            <h3>批量删除缩略图</h3>
            <p className="confirm-message">共找到 {thumbDeleteConfirm.count} 张缩略图缓存</p>
            <p className="confirm-warning">删除后查看图片时会重新生成，此操作不可恢复。</p>
            <div className="confirm-actions">
              <button className="btn btn-secondary" onClick={() => setThumbDeleteConfirm({ show: false, count: 0 })}>
                取消
              </button>
              <button className="btn btn-danger" onClick={() => void confirmDeleteThumbnails()}>
                确定删除
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="page-header">
        <h1>数据管理</h1>
        <div className="header-tabs">
          <button
            className={`tab-btn ${activeTab === 'images' ? 'active' : ''}`}
            onClick={() => setActiveTab('images')}
          >
            <Picture width={16} height={16} />
            图片 ({images.length})
          </button>
          <button
            className={`tab-btn ${activeTab === 'emojis' ? 'active' : ''}`}
            onClick={() => setActiveTab('emojis')}
          >
            <FaceSmile width={16} height={16} />
            表情包 ({emojis.length})
          </button>
        </div>
      </div>

      {activeTab === 'images' && renderMediaGrid('images')}
      {activeTab === 'emojis' && renderMediaGrid('emojis')}
    </>
  )
}

export default DataManagementPage
