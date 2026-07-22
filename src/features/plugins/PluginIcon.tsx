import type { SVGProps } from 'react'
import {
  ArrowDownToLine,
  BookOpen,
  Calendar,
  Clock,
  Comment,
  Database,
  FaceSmile,
  FileText,
  Globe,
  Heart,
  Magnifier,
  Microphone,
  Persons,
  Picture,
  Puzzle,
  Sparkles,
  Star,
  Tag,
  Thunderbolt,
  ChartColumn,
} from '@gravity-ui/icons'

/**
 * 插件贡献点图标：manifest 里声明图标名，宿主用内置图标集合渲染。
 * 未知名字回退 Puzzle——渲染贡献点不执行任何插件代码。
 */
type PluginIconComponent = (props: SVGProps<SVGSVGElement>) => React.JSX.Element

const ICON_MAP: Record<string, PluginIconComponent> = {
  'bar-chart': ChartColumn,
  'chart-bar': ChartColumn,
  'book-open': BookOpen,
  calendar: Calendar,
  clock: Clock,
  database: Database,
  download: ArrowDownToLine,
  'file-text': FileText,
  globe: Globe,
  heart: Heart,
  image: Picture,
  'message-square': Comment,
  mic: Microphone,
  puzzle: Puzzle,
  search: Magnifier,
  smile: FaceSmile,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  users: Persons,
  zap: Thunderbolt,
}

export function PluginIcon({ name, size }: { name?: string; size?: number }) {
  const Icon = (name && ICON_MAP[name]) || Puzzle
  return <Icon width={size} height={size} />
}
