/**
 * CipherTalk 插件 UI 组件库（React，单文件 ESM，SDK 的 `/ui` 子路径导出）。
 *
 * 这些组件是宿主注入的 `.ct-*` 样式类的薄封装——**不自带 CSS**，观感与暗色
 * 全部由宿主在握手时注入的组件库提供（见本包 connect()）。
 * 因此组件极小，且天然与宿主主题一致、随宿主切换暗色。
 *
 * 用法：
 *   import { connect } from 'ciphertalk-plugin-sdk'
 *   import { Button, Card, LazyList } from 'ciphertalk-plugin-sdk/ui'
 *   const api = await connect()   // connect 会注入 .ct-* 样式
 *   // 之后正常渲染 React 组件即可
 *
 * react 为可选 peer 依赖：不用 React 的插件不 import 本入口即可，
 * 直接写 `<button class="ct-btn ct-btn-primary">` 等语义化 HTML + `.ct-*` 类。
 */
import { createElement as h, Fragment, useEffect, useRef, useState } from 'react'

/** SDK 版本对齐用；组件不依赖具体 API 版本 */
export const UI_VERSION = '1.1.0'

function cx(...parts) {
  return parts.filter(Boolean).join(' ')
}

// ========= 排版 =========

export function Title({ className, children, ...rest }) {
  return h('h3', { className: cx('ct-title', className), ...rest }, children)
}
export function Hint({ className, children, ...rest }) {
  return h('p', { className: cx('ct-hint', className), ...rest }, children)
}
export function Label({ className, children, ...rest }) {
  return h('label', { className: cx('ct-label', className), ...rest }, children)
}

// ========= 按钮 =========

const BTN_VARIANT = {
  default: '',
  primary: 'ct-btn-primary',
  ghost: 'ct-btn-ghost',
  danger: 'ct-btn-danger',
}

export function Button({ variant = 'default', block, className, children, ...rest }) {
  return h(
    'button',
    { className: cx('ct-btn', BTN_VARIANT[variant] || '', block && 'ct-btn-block', className), ...rest },
    children,
  )
}

// ========= 表单 =========

export function Input({ className, ...rest }) {
  return h('input', { className: cx('ct-input', className), ...rest })
}
export function Textarea({ className, ...rest }) {
  return h('textarea', { className: cx('ct-textarea', className), ...rest })
}

/**
 * 下拉框：渲染原生 <select class="ct-select">，其弹出层由宿主接管
 * （SDK 的 enhanceSelects 自动生效），无需额外配置。
 * 传 options 数组或直接传 <option> children 均可。
 */
export function Select({ options, className, children, ...rest }) {
  return h(
    'select',
    { className: cx('ct-select', className), ...rest },
    options ? options.map((o) => h('option', { key: o.value, value: o.value }, o.label)) : children,
  )
}

export function Switch({ checked, onChange, disabled, className, children }) {
  return h(
    'label',
    { className: cx('ct-switch', className) },
    h('input', {
      type: 'checkbox',
      checked: !!checked,
      disabled,
      onChange: (e) => onChange && onChange(e.target.checked),
    }),
    h('span', null),
    children != null ? children : null,
  )
}

export function Checkbox({ checked, onChange, disabled, className, children }) {
  return h(
    'label',
    { className: cx('ct-checkbox', className) },
    h('input', {
      type: 'checkbox',
      checked: !!checked,
      disabled,
      onChange: (e) => onChange && onChange(e.target.checked),
    }),
    children != null ? children : null,
  )
}

// ========= 容器 / 展示 =========

export function Card({ className, children, ...rest }) {
  return h('div', { className: cx('ct-card', className), ...rest }, children)
}
export function Divider({ className }) {
  return h('hr', { className: cx('ct-divider', className) })
}
export function Chip({ accent, className, children, ...rest }) {
  return h('span', { className: cx('ct-chip', accent && 'ct-chip-accent', className), ...rest }, children)
}
export function Badge({ className, children }) {
  return h('span', { className: cx('ct-badge', className) }, children)
}
export function Dot({ status, className }) {
  return h('span', {
    className: cx('ct-dot', status === 'success' && 'ct-dot-success', status === 'danger' && 'ct-dot-danger', className),
  })
}
export function Code({ className, children }) {
  return h('pre', { className: cx('ct-code', className) }, children)
}
export function Spinner({ className }) {
  return h('span', { className: cx('ct-spinner', className) })
}
export function Skeleton({ width, height, className, style }) {
  return h('div', { className: cx('ct-skeleton', className), style: { width, height, ...style } })
}
export function Progress({ value, max = 100, className }) {
  return h('progress', { className: cx('ct-progress', className), value, max })
}

export function List({ className, children, ...rest }) {
  return h('div', { className: cx('ct-list', className), ...rest }, children)
}
export function ListItem({ className, children, ...rest }) {
  return h('div', { className: cx('ct-list-item', className), ...rest }, children)
}
export function Empty({ className, children }) {
  return h('div', { className: cx('ct-empty', className) }, children)
}

/**
 * 懒加载列表：滚动到底自动取下一批，开发者不用管翻页。
 *   <LazyList source={() => api.data.sessions.iterate()}
 *             renderItem={(s) => <ListItem>{s.displayName}</ListItem>} />
 * source: 返回异步迭代器的函数（推荐，重挂载可重新遍历），或直接传迭代器。
 * batchSize: 每次滚动到底追加的条数，默认 50。
 */
export function LazyList({ source, renderItem, batchSize = 50, className, emptyText = '暂无数据' }) {
  const [items, setItems] = useState([])
  const [done, setDone] = useState(false)
  const sentinelRef = useRef(null)

  useEffect(() => {
    const iterator = typeof source === 'function' ? source() : source
    const st = { loading: false, done: !iterator, alive: true }
    setItems([])
    setDone(st.done)
    const el = sentinelRef.current
    if (!el || st.done) return

    const loadMore = async () => {
      st.loading = true
      const batch = []
      try {
        for (let i = 0; i < batchSize; i++) {
          const { value, done } = await iterator.next()
          if (done) { st.done = true; break }
          batch.push(value)
        }
      } catch {
        st.done = true
      }
      st.loading = false
      if (!st.alive) return
      if (batch.length) setItems((prev) => [...prev, ...batch])
      if (st.done) setDone(true)
    }

    const io = new IntersectionObserver(async (entries) => {
      if (!entries.some((e) => e.isIntersecting) || st.loading || st.done) return
      await loadMore()
      // 首屏没铺满时不会再触发回调，重新 observe 拿一次当前相交状态续拉
      if (st.alive && !st.done) { io.unobserve(el); io.observe(el) }
    })
    io.observe(el)
    return () => { st.alive = false; io.disconnect() }
  }, [source, batchSize])

  return h(
    'div',
    { className: cx('ct-list', className) },
    items.length === 0 && done
      ? h(Empty, null, emptyText)
      : items.map((item, i) => h(Fragment, { key: i }, renderItem ? renderItem(item, i) : h(ListItem, null, String(item)))),
    !done ? h('div', { ref: sentinelRef, style: { display: 'flex', justifyContent: 'center', padding: 8 } }, h(Spinner)) : null,
  )
}

// ========= Tabs（受控） =========

export function Tabs({ tabs = [], value, onChange, className }) {
  return h(
    'div',
    { className: cx('ct-tabs', className) },
    tabs.map((t) =>
      h(
        'button',
        {
          key: t.value,
          className: cx('ct-tab', value === t.value && 'active'),
          onClick: () => onChange && onChange(t.value),
        },
        t.label,
      ),
    ),
  )
}

// ========= 下拉菜单（原生 details，零 JS） =========

export function Menu({ label, className, children }) {
  return h(
    'details',
    { className: cx('ct-menu', className) },
    h('summary', { className: 'ct-btn' }, label),
    h('div', { className: 'ct-menu-panel' }, children),
  )
}
export function MenuItem({ className, children, ...rest }) {
  return h('button', { className: cx('ct-menu-item', className), ...rest }, children)
}

// ========= 弹窗（原生 <dialog>，受 open 控制） =========

export function Dialog({ open, onClose, title, className, children, actions }) {
  const ref = useRef(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (open && !el.open) el.showModal()
    else if (!open && el.open) el.close()
  }, [open])
  return h(
    'dialog',
    {
      ref,
      className: cx('ct-dialog', className),
      // Esc / backdrop 取消时同步回报关闭
      onCancel: (e) => {
        e.preventDefault()
        onClose && onClose()
      },
      onClose: () => onClose && onClose(),
    },
    title != null ? h('h4', { className: 'ct-dialog-title' }, title) : null,
    children,
    actions != null ? h('div', { className: 'ct-dialog-actions' }, actions) : null,
  )
}

// ========= DataTable（排序 + 可选分页） =========

/**
 * columns: [{ key, title, sortable?, align?, render?(row) => node }]
 * rows:    对象数组
 * pageSize: 传入即分页；不传则一次展示全部
 */
export function DataTable({ columns = [], rows = [], pageSize, className, emptyText = '暂无数据' }) {
  const [sort, setSort] = useState({ key: null, dir: 'asc' })
  const [page, setPage] = useState(0)

  let view = rows
  if (sort.key) {
    view = [...rows].sort((a, b) => {
      const av = a[sort.key]
      const bv = b[sort.key]
      let r
      if (av == null && bv == null) r = 0
      else if (av == null) r = -1
      else if (bv == null) r = 1
      else if (typeof av === 'number' && typeof bv === 'number') r = av - bv
      else r = String(av).localeCompare(String(bv))
      return sort.dir === 'asc' ? r : -r
    })
  }

  const paged = pageSize && pageSize > 0
  const size = paged ? pageSize : view.length || 1
  const pageCount = Math.max(1, Math.ceil(view.length / size))
  const cur = Math.min(page, pageCount - 1)
  const pageRows = paged ? view.slice(cur * size, (cur + 1) * size) : view

  const toggleSort = (col) => {
    if (!col.sortable) return
    setSort((s) => (s.key === col.key ? { key: col.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: 'asc' }))
    setPage(0)
  }

  const head = h(
    'thead',
    null,
    h(
      'tr',
      null,
      columns.map((col) =>
        h(
          'th',
          {
            key: col.key,
            className: col.sortable ? 'ct-th-sortable' : undefined,
            style: col.align ? { textAlign: col.align } : undefined,
            onClick: () => toggleSort(col),
          },
          col.title,
          col.sortable && sort.key === col.key
            ? h('span', { className: 'ct-th-arrow' }, sort.dir === 'asc' ? '▲' : '▼')
            : null,
        ),
      ),
    ),
  )

  const body = h(
    'tbody',
    null,
    pageRows.length === 0
      ? h('tr', null, h('td', { colSpan: columns.length, style: { textAlign: 'center', color: 'var(--text-tertiary)' } }, emptyText))
      : pageRows.map((row, ri) =>
          h(
            'tr',
            { key: ri },
            columns.map((col) =>
              h('td', { key: col.key, style: col.align ? { textAlign: col.align } : undefined }, col.render ? col.render(row) : row[col.key]),
            ),
          ),
        ),
  )

  return h(
    'div',
    { className: cx('ct-table-wrap', className) },
    h('table', { className: 'ct-table' }, head, body),
    paged && pageCount > 1
      ? h(
          'div',
          { className: 'ct-pagination' },
          h(Button, { variant: 'ghost', disabled: cur <= 0, onClick: () => setPage(cur - 1) }, '上一页'),
          h('span', null, `${cur + 1} / ${pageCount}`),
          h(Button, { variant: 'ghost', disabled: cur >= pageCount - 1, onClick: () => setPage(cur + 1) }, '下一页'),
        )
      : null,
  )
}

// ========= BarChart（纯 flex 柱状图，取主题强调色） =========

/** data: [{ label, value }]；height 为图表像素高度 */
export function BarChart({ data = [], height = 180, className }) {
  const max = Math.max(1, ...data.map((d) => Number(d.value) || 0))
  return h(
    'div',
    { className: cx('ct-chart', className), style: { height } },
    data.map((d, i) =>
      h(
        'div',
        { key: i, className: 'ct-chart-col', title: `${d.label}: ${d.value}` },
        h('span', { className: 'ct-chart-value' }, String(d.value)),
        h('div', { className: 'ct-chart-bar', style: { height: `${((Number(d.value) || 0) / max) * 100}%` } }),
        h('span', { className: 'ct-chart-label' }, String(d.label)),
      ),
    ),
  )
}
