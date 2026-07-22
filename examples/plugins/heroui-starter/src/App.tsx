import { useEffect, useState } from 'react'
import { Button, Card, Chip, Spinner, toast } from '@heroui/react'
import type { CipherTalkAPI, SessionSummary } from 'ciphertalk-plugin-sdk'

/**
 * 示例视图：真正的 HeroUI 组件 + 一次真实数据调用（读最近会话）。
 * api 由 main.tsx 在握手完成后注入。
 */
export default function App({ api }: { api: CipherTalkAPI }) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.data.sessions
      .list({ limit: 10 })
      .then((r) => setSessions(r.sessions))
      .catch((e) => toast.danger(String(e)))
      .finally(() => setLoading(false))
  }, [api])

  return (
    <div className="flex flex-col gap-4 p-6">
      <div>
        <h1 className="text-lg font-semibold text-foreground">HeroUI 示例插件</h1>
        <p className="text-sm text-muted-foreground">
          这里用的是真正的 HeroUI 组件，主题（含暗色）随宿主自动切换。
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onPress={() => toast.success('这是 HeroUI 的 toast（插件自带）')}>HeroUI toast</Button>
        <Button variant="secondary" onPress={() => api.ui.toast('这是宿主的 toast')}>宿主 toast</Button>
      </div>

      <Card>
        <Card.Header>
          <Card.Title>最近会话</Card.Title>
        </Card.Header>
        <Card.Content>
          {loading ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">没有会话</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {sessions.map((s) => (
                <li key={s.sessionId} className="flex items-center justify-between gap-3">
                  <span className="truncate">{s.displayName || s.sessionId}</span>
                  <Chip size="sm" variant="soft">
                    type {s.type}
                  </Chip>
                </li>
              ))}
            </ul>
          )}
        </Card.Content>
      </Card>
    </div>
  )
}
