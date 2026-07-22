import { Avatar, Radio } from '@heroui/react'

export type QuoteStyle = 'default' | 'wechat' | 'card'

interface QuoteStyleOptionCardProps {
  value: QuoteStyle
  avatarUrl?: string
  avatarFallback: string
}

function QuotePreviewAvatar({
  avatarUrl,
  avatarFallback
}: {
  avatarUrl?: string
  avatarFallback: string
}) {
  return (
    <Avatar className="preview-avatar">
      {avatarUrl && <Avatar.Image alt="我的头像" loading="lazy" src={avatarUrl} />}
      <Avatar.Fallback>{avatarFallback}</Avatar.Fallback>
    </Avatar>
  )
}

function QuoteStyleOptionCard({
  value,
  avatarUrl,
  avatarFallback
}: QuoteStyleOptionCardProps) {
  const isWechat = value === 'wechat'
  const isCard = value === 'card'

  return (
    <Radio className="radio-label" value={value}>
      <Radio.Control className="absolute top-3 right-4 size-5">
        <Radio.Indicator />
      </Radio.Control>
      <Radio.Content className="radio-content">
        <div className="style-preview">
          <QuotePreviewAvatar avatarFallback={avatarFallback} avatarUrl={avatarUrl} />
          {isCard ? (
            <div className="preview-group preview-group-line">
              <div className="preview-bubble wechat">拍得真不错！</div>
              <div className="preview-quote-line">
                <span className="preview-quote-sender">我: </span>
                <span className="preview-quote-text">那天去爬山的照片...</span>
              </div>
            </div>
          ) : isWechat ? (
            <div className="preview-group">
              <div className="preview-bubble wechat">拍得真不错！</div>
              <div className="preview-quote-bubble">我: 那天去爬山的照片...</div>
            </div>
          ) : (
            <div className="preview-bubble default">
              <div className="preview-quote">我: 那天去爬山的照片...</div>
              <div className="preview-text">拍得真不错！</div>
            </div>
          )}
        </div>
      </Radio.Content>
    </Radio>
  )
}

export default QuoteStyleOptionCard
