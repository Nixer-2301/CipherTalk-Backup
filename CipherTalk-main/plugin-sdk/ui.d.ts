/** CipherTalk 插件 UI 组件库类型声明（与 ui.js 对应，经 `ciphertalk-plugin-sdk/ui` 导入） */
import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

export const UI_VERSION: string

export function Title(props: HTMLAttributes<HTMLHeadingElement> & { children?: ReactNode }): JSX.Element
export function Hint(props: HTMLAttributes<HTMLParagraphElement> & { children?: ReactNode }): JSX.Element
export function Label(props: HTMLAttributes<HTMLLabelElement> & { children?: ReactNode }): JSX.Element

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'ghost' | 'danger'
  block?: boolean
}
export function Button(props: ButtonProps): JSX.Element

export function Input(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element
export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  /** 传入即自动生成 <option>；也可改用 children */
  options?: Array<{ value: string; label: string }>
}
export function Select(props: SelectProps): JSX.Element

export interface ToggleProps {
  checked?: boolean
  onChange?: (checked: boolean) => void
  disabled?: boolean
  className?: string
  children?: ReactNode
}
export function Switch(props: ToggleProps): JSX.Element
export function Checkbox(props: ToggleProps): JSX.Element

export function Card(props: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }): JSX.Element
export function Divider(props: { className?: string }): JSX.Element
export function Chip(props: HTMLAttributes<HTMLSpanElement> & { accent?: boolean; children?: ReactNode }): JSX.Element
export function Badge(props: { className?: string; children?: ReactNode }): JSX.Element
export function Dot(props: { status?: 'success' | 'danger'; className?: string }): JSX.Element
export function Code(props: { className?: string; children?: ReactNode }): JSX.Element
export function Spinner(props: { className?: string }): JSX.Element
export function Skeleton(props: { width?: number | string; height?: number | string; className?: string; style?: Record<string, unknown> }): JSX.Element
export function Progress(props: { value?: number; max?: number; className?: string }): JSX.Element

export function List(props: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }): JSX.Element
export function ListItem(props: HTMLAttributes<HTMLDivElement> & { children?: ReactNode }): JSX.Element
export function Empty(props: { className?: string; children?: ReactNode }): JSX.Element

export interface LazyListProps<Item = unknown> {
  /** 返回异步迭代器的函数（推荐，如 () => api.data.sessions.iterate()），或直接传迭代器 */
  source: (() => AsyncIterator<Item> & { [Symbol.asyncIterator]?(): AsyncIterator<Item> }) | AsyncIterator<Item>
  renderItem?: (item: Item, index: number) => ReactNode
  /** 每次滚动到底追加的条数，默认 50 */
  batchSize?: number
  className?: string
  emptyText?: string
}
/** 懒加载列表：滚动到底自动从 source 取下一批，无需处理翻页 */
export function LazyList<Item = unknown>(props: LazyListProps<Item>): JSX.Element

export interface TabItem { value: string; label: ReactNode }
export function Tabs(props: { tabs: TabItem[]; value: string; onChange?: (value: string) => void; className?: string }): JSX.Element

export function Menu(props: { label: ReactNode; className?: string; children?: ReactNode }): JSX.Element
export function MenuItem(props: ButtonHTMLAttributes<HTMLButtonElement> & { children?: ReactNode }): JSX.Element

export function Dialog(props: {
  open: boolean
  onClose?: () => void
  title?: ReactNode
  className?: string
  children?: ReactNode
  actions?: ReactNode
}): JSX.Element

export interface DataTableColumn<Row = Record<string, unknown>> {
  key: string
  title: ReactNode
  sortable?: boolean
  align?: 'left' | 'center' | 'right'
  render?: (row: Row) => ReactNode
}
export function DataTable<Row = Record<string, unknown>>(props: {
  columns: DataTableColumn<Row>[]
  rows: Row[]
  /** 传入即分页；不传一次展示全部 */
  pageSize?: number
  className?: string
  emptyText?: string
}): JSX.Element

export function BarChart(props: {
  data: Array<{ label: string; value: number }>
  height?: number
  className?: string
}): JSX.Element
