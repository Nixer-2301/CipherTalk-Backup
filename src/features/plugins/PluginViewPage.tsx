import { useParams } from 'react-router-dom'
import PluginHost from './PluginHost'

/** 主区域插件页面：/plugin/:pluginId/:viewId */
export default function PluginViewPage() {
  const { pluginId, viewId } = useParams<{ pluginId: string; viewId: string }>()
  if (!pluginId || !viewId) return null
  return (
    <div className="h-full w-full">
      <PluginHost pluginId={pluginId} viewId={viewId} />
    </div>
  )
}
