import { connect } from './ciphertalk-plugin-sdk.js'

// 画廊纯展示 .ct-* 类；仅 toast/clipboard 用到宿主 API
const api = await connect()

// ── 弹 toast ──
document.getElementById('toast-btn').addEventListener('click', () => {
  api.ui.toast('这是一条来自组件画廊的提示', { type: 'success' })
})

// ── Tabs 切换（配合 .active） ──
const tabs = document.getElementById('tabs')
const echo = document.getElementById('tab-echo')
const TAB_LABEL = { all: '全部', img: '图片', file: '文件' }
tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('.ct-tab')
  if (!btn) return
  tabs.querySelectorAll('.ct-tab').forEach((b) => b.classList.toggle('active', b === btn))
  echo.textContent = `当前分页：${TAB_LABEL[btn.dataset.tab] || ''}`
})

// ── 弹窗 ──
const dlg = document.getElementById('dlg')
document.getElementById('dlg-open').addEventListener('click', () => dlg.showModal())
document.getElementById('dlg-cancel').addEventListener('click', () => dlg.close())
document.getElementById('dlg-ok').addEventListener('click', () => {
  api.ui.toast('已确定')
  dlg.close()
})

// ── 表格（点表头排序，演示 DataTable 组件产出的同款 DOM 结构） ──
const rows = [
  { name: '张三', count: 1280, last: '07-01' },
  { name: '李四', count: 342, last: '06-28' },
  { name: '王五', count: 5671, last: '07-03' },
  { name: '赵六', count: 89, last: '06-19' },
]
const columns = [
  { key: 'name', title: '联系人', sortable: true },
  { key: 'count', title: '消息数', sortable: true, align: 'right' },
  { key: 'last', title: '最近', sortable: true, align: 'right' },
]
const table = document.getElementById('table')
let sortKey = null
let sortDir = 'asc'

function renderTable() {
  let view = rows
  if (sortKey) {
    view = [...rows].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const r = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return sortDir === 'asc' ? r : -r
    })
  }
  const head = columns
    .map((c) => {
      const arrow = sortKey === c.key ? `<span class="ct-th-arrow">${sortDir === 'asc' ? '▲' : '▼'}</span>` : ''
      const align = c.align ? ` style="text-align:${c.align}"` : ''
      return `<th class="${c.sortable ? 'ct-th-sortable' : ''}" data-key="${c.key}"${align}>${c.title}${arrow}</th>`
    })
    .join('')
  const body = view
    .map((row) => {
      const tds = columns
        .map((c) => `<td${c.align ? ` style="text-align:${c.align}"` : ''}>${row[c.key]}</td>`)
        .join('')
      return `<tr>${tds}</tr>`
    })
    .join('')
  table.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`
}
table.addEventListener('click', (e) => {
  const th = e.target.closest('th.ct-th-sortable')
  if (!th) return
  const key = th.dataset.key
  if (sortKey === key) sortDir = sortDir === 'asc' ? 'desc' : 'asc'
  else { sortKey = key; sortDir = 'asc' }
  renderTable()
})
renderTable()

// ── 柱状图（与 BarChart 组件同款结构：.ct-chart > .ct-chart-col） ──
const chartData = [
  { label: '周一', value: 120 },
  { label: '周二', value: 88 },
  { label: '周三', value: 200 },
  { label: '周四', value: 46 },
  { label: '周五', value: 150 },
  { label: '周六', value: 233 },
  { label: '周日', value: 175 },
]
const chart = document.getElementById('chart')
const max = Math.max(1, ...chartData.map((d) => d.value))
chart.innerHTML = chartData
  .map(
    (d) => `<div class="ct-chart-col" title="${d.label}: ${d.value}">
      <span class="ct-chart-value">${d.value}</span>
      <div class="ct-chart-bar" style="height:${(d.value / max) * 100}%"></div>
      <span class="ct-chart-label">${d.label}</span>
    </div>`,
  )
  .join('')
