/**
 * HTML 导出生成器
 * 生成现代风格的聊天记录 HTML 页面
 * 支持图片/视频内联显示、搜索、主题切换、日期跳转
 * 支持消息类型筛选、时间范围筛选、统计面板（聚合网页）
 */

import * as fs from 'fs'
import * as path from 'path'

export interface HtmlExportMessage {
  timestamp: number
  sender: string
  senderName: string
  type: number
  content: string | null
  rawContent: string
  isSend: boolean
  quote?: { sender?: string; content: string }
  chatRecords?: HtmlChatRecord[]
}

export interface HtmlChatRecord {
  sender: string
  senderDisplayName: string
  timestamp: number
  formattedTime: string
  type: string
  datatype: number
  content: string
  senderAvatar?: string
  fileExt?: string
  fileSize?: number
}

export interface HtmlMember {
  id: string
  name: string
  avatar?: string
}

export interface HtmlExportData {
  meta: {
    sessionId: string
    sessionName: string
    sessionAvatar?: string
    isGroup: boolean
    exportTime: number
    messageCount: number
    dateRange: { start: number; end: number } | null
  }
  members: HtmlMember[]
  messages: HtmlExportMessage[]
}

const WECHAT_EMOJI_DIRS = ['face', 'gesture', 'animal', 'blessing', 'other']

export class HtmlExportGenerator {
  /**
   * 生成完整的单文件 HTML（内联 CSS + JS + 数据）
   */
  static generateHtmlWithData(exportData: HtmlExportData): string {
    const escapedSessionName = this.escapeHtml(exportData.meta.sessionName)
    const dateRangeText = exportData.meta.dateRange
      ? `${new Date(exportData.meta.dateRange.start * 1000).toLocaleDateString('zh-CN')} - ${new Date(exportData.meta.dateRange.end * 1000).toLocaleDateString('zh-CN')}`
      : ''
    const wechatEmojiMap = this.buildWechatEmojiDataMap(exportData)

    const avatarHtml = exportData.meta.sessionAvatar
      ? `<img src="${this.escapeHtml(exportData.meta.sessionAvatar)}" onerror="this.style.display='none';this.parentElement.textContent='${escapedSessionName.charAt(0)}'"/>`
      : escapedSessionName.charAt(0)

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapedSessionName} - 聊天记录</title>
  <style>${this.generateCss()}</style>
</head>
<body>
  <div class="app">
    <header class="chat-header">
      <div class="header-left">
        <div class="header-avatar">${avatarHtml}</div>
        <div class="header-info">
          <h1>${escapedSessionName}</h1>
          <span class="header-meta">${exportData.messages.length} 条消息${dateRangeText ? ' · ' + dateRangeText : ''}</span>
        </div>
      </div>
      <div class="header-actions">
        <button class="icon-btn" id="statsToggle" title="统计面板">📊</button>
        <button class="icon-btn" id="filterToggle" title="筛选面板">🔽</button>
        <button class="icon-btn" id="dateJumpToggle" title="跳转到指定日期">📅</button>
        <button class="icon-btn" id="themeToggle" title="切换主题">🌓</button>
        <button class="icon-btn" id="searchToggle" title="搜索">🔍</button>
      </div>
    </header>

    <!-- 统计面板 -->
    <div class="stats-panel" id="statsPanel">
      <div class="stats-row" id="statsRow"></div>
    </div>

    <!-- 消息类型筛选面板 -->
    <div class="filter-panel" id="filterPanel">
      <div class="filter-label">消息类型</div>
      <div class="filter-tags" id="typeFilters"></div>
      <div class="filter-divider"></div>
      <div class="filter-label">时间范围</div>
      <div class="date-range-row">
        <input type="date" id="filterDateStart" />
        <span class="date-range-sep">至</span>
        <input type="date" id="filterDateEnd" />
        <button class="filter-btn" id="applyDateFilter">确定</button>
        <button class="filter-btn secondary" id="clearDateFilter">重置</button>
      </div>
      <div class="filter-result" id="filterResult"></div>
    </div>

    <div class="search-bar" id="searchBar">
      <input type="text" id="searchInput" placeholder="搜索消息内容或发送者..." />
      <span id="searchCount"></span>
      <button id="clearSearch">✕</button>
    </div>

    <div class="date-jump-bar" id="dateJumpBar">
      <input type="date" id="dateJumpInput" />
      <button id="dateJumpBtn">跳转</button>
      <span id="dateJumpHint"></span>
      <button id="closeDateJump">✕</button>
    </div>

    <div class="chat-body" id="chatBody">
      <div id="messagesContainer"></div>
      <div class="loading-indicator" id="loadingIndicator">加载中...</div>
    </div>

    <footer class="chat-footer">
      由 <strong>CipherTalk</strong> 导出 · ${new Date(exportData.meta.exportTime).toLocaleString('zh-CN')}
    </footer>
  </div>

  <div class="lightbox" id="lightbox">
    <button class="lightbox-close" id="lightboxClose">✕</button>
    <img id="lightboxImg" />
  </div>

  <script>window.CHAT_DATA = ${JSON.stringify(exportData)};</script>
  <script>window.WECHAT_EMOJIS = ${JSON.stringify(wechatEmojiMap)};</script>
  <script>${this.generateJs()}</script>
</body>
</html>`
  }

  static generateCss(): string {
    return `
:root {
  --bg: #eef1f6;
  --chat-bg: #f7f8fa;
  --header-bg: #ffffff;
  --header-text: #1a2027;
  --bubble-recv: #ffffff;
  --bubble-send: #e7f0ff;
  --text: #1a2027;
  --text-secondary: #6b7785;
  --text-time: #9aa6b2;
  --border: #e8ebf0;
  --search-bg: #f2f4f7;
  --system-bg: rgba(20,30,50,0.05);
  --system-text: #6b7785;
  --shadow: rgba(20,30,50,0.07);
  --link: #2563eb;
  --accent: #2563eb;
  --media-bg: #eef1f5;
  --panel-bg: #ffffff;
  --tag-bg: #f2f4f7;
  --tag-active-bg: #2563eb;
  --tag-active-text: #fff;
  --stat-value: #2563eb;
  --btn-hover: rgba(20,30,50,0.06);
}

[data-theme="dark"] {
  --bg: #0d1117;
  --chat-bg: #0d1117;
  --header-bg: #161b22;
  --header-text: #e6edf3;
  --bubble-recv: #1c232b;
  --bubble-send: #1e3a5f;
  --text: #e6edf3;
  --text-secondary: #8b98a5;
  --text-time: #6e7b87;
  --border: #2a313a;
  --search-bg: #222c36;
  --system-bg: rgba(255,255,255,0.06);
  --system-text: #8b98a5;
  --shadow: rgba(0,0,0,0.4);
  --link: #60a5fa;
  --accent: #60a5fa;
  --media-bg: #222c36;
  --panel-bg: #161b22;
  --tag-bg: #222c36;
  --tag-active-bg: #2563eb;
  --tag-active-text: #fff;
  --stat-value: #60a5fa;
  --btn-hover: rgba(255,255,255,0.08);
}

* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
}

.app {
  max-width: 880px;
  margin: 0 auto;
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--chat-bg);
  box-shadow: 0 0 60px var(--shadow);
}

.chat-header {
  background: var(--header-bg);
  color: var(--header-text);
  padding: 12px 18px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-shrink: 0;
  z-index: 10;
  border-bottom: 1px solid var(--border);
}

.header-left { display: flex; align-items: center; gap: 12px; min-width: 0; }

.header-avatar {
  width: 40px; height: 40px; border-radius: 12px;
  background: var(--accent); color: #fff;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 600; flex-shrink: 0; overflow: hidden;
}
.header-avatar img { width: 100%; height: 100%; object-fit: cover; }
.header-info { min-width: 0; }
.header-info h1 { font-size: 16px; font-weight: 600; letter-spacing: -0.2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.header-meta { font-size: 12px; color: var(--text-secondary); }
.header-actions { display: flex; gap: 2px; }

.icon-btn {
  background: none; border: none; color: var(--text-secondary);
  font-size: 17px; cursor: pointer; padding: 8px; border-radius: 10px;
  transition: background 0.18s, color 0.18s; line-height: 1;
}
.icon-btn:hover { background: var(--btn-hover); color: var(--text); }

/* 统计面板 */
.stats-panel {
  background: var(--panel-bg);
  border-bottom: 1px solid var(--border);
  display: none; padding: 12px 16px; flex-shrink: 0;
}
.stats-panel.active { display: block; }
.stats-row { display: flex; flex-wrap: wrap; gap: 8px; }
.stat-card {
  background: var(--tag-bg); border-radius: 10px;
  padding: 10px 14px; min-width: 90px; flex: 1; text-align: center;
}
.stat-card .stat-num { font-size: 22px; font-weight: 700; color: var(--stat-value); line-height: 1.2; }
.stat-card .stat-label { font-size: 11px; color: var(--text-secondary); margin-top: 2px; }

/* 筛选面板 */
.filter-panel {
  background: var(--panel-bg);
  border-bottom: 1px solid var(--border);
  display: none; padding: 12px 16px; flex-shrink: 0;
}
.filter-panel.active { display: block; }
.filter-label { font-size: 12px; font-weight: 600; color: var(--text-secondary); margin-bottom: 8px; letter-spacing: 0.5px; }
.filter-tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }

.type-tag {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 5px 12px; border-radius: 16px;
  border: 1.5px solid var(--border); background: var(--tag-bg);
  color: var(--text); font-size: 13px; cursor: pointer;
  transition: all 0.15s; user-select: none;
}
.type-tag:hover { border-color: var(--tag-active-bg); }
.type-tag.active { background: var(--tag-active-bg); color: var(--tag-active-text); border-color: var(--tag-active-bg); }
.type-tag .tag-count { font-size: 11px; opacity: 0.7; font-weight: 600; }
.type-tag.active .tag-count { opacity: 0.9; }

.filter-divider { height: 1px; background: var(--border); margin: 10px 0; }

.date-range-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.date-range-row input[type="date"] {
  padding: 6px 10px; border: 1.5px solid var(--border); border-radius: 8px;
  background: var(--tag-bg); color: var(--text); font-size: 13px; outline: none;
}
.date-range-row input[type="date"]:focus { border-color: var(--tag-active-bg); }
.date-range-sep { color: var(--text-secondary); font-size: 13px; }

.filter-btn {
  padding: 6px 16px; border: none; border-radius: 8px;
  background: var(--tag-active-bg); color: var(--tag-active-text);
  font-size: 13px; cursor: pointer; transition: opacity 0.15s;
}
.filter-btn:hover { opacity: 0.85; }
.filter-btn.secondary { background: var(--tag-bg); color: var(--text); border: 1.5px solid var(--border); }

.filter-result { margin-top: 8px; font-size: 12px; color: var(--text-secondary); }

/* 搜索栏 */
.search-bar {
  background: var(--header-bg); padding: 0 18px 12px;
  display: none; align-items: center; gap: 8px; border-bottom: 1px solid var(--border);
}
.search-bar.active { display: flex; }
.search-bar input {
  flex: 1; padding: 9px 14px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--search-bg); color: var(--text); font-size: 14px; outline: none; transition: border-color 0.15s;
}
.search-bar input:focus { border-color: var(--accent); }
.search-bar input::placeholder { color: var(--text-secondary); }
#searchCount { color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
#clearSearch { background: none; border: none; color: var(--text-secondary); font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 8px; }
#clearSearch:hover { background: var(--btn-hover); }

/* 日期跳转栏 */
.date-jump-bar {
  background: var(--header-bg); padding: 0 18px 12px;
  display: none; align-items: center; gap: 8px; border-bottom: 1px solid var(--border);
}
.date-jump-bar.active { display: flex; }
.date-jump-bar input[type="date"] {
  padding: 8px 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--search-bg); color: var(--text); font-size: 14px; outline: none;
}
.date-jump-bar input[type="date"]:focus { border-color: var(--accent); }
#dateJumpBtn {
  padding: 8px 16px; border: none; border-radius: 10px;
  background: var(--accent); color: #fff; font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity 0.15s;
}
#dateJumpBtn:hover { opacity: 0.88; }
#dateJumpHint { color: var(--text-secondary); font-size: 12px; white-space: nowrap; }
#closeDateJump { background: none; border: none; color: var(--text-secondary); font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 8px; }
#closeDateJump:hover { background: var(--btn-hover); }

/* 聊天体 */
.chat-body { flex: 1; overflow-y: auto; background: var(--chat-bg); padding: 8px 0; }
.chat-body::-webkit-scrollbar { width: 6px; }
.chat-body::-webkit-scrollbar-track { background: transparent; }
.chat-body::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.2); border-radius: 3px; }

.date-divider { text-align: center; padding: 12px 0 8px; }
.date-divider span { background: var(--system-bg); color: var(--system-text); padding: 4px 12px; border-radius: 8px; font-size: 12px; font-weight: 500; }
.date-divider.highlight span { background: var(--link); color: #fff; animation: dateHighlight 2s ease-out forwards; }
@keyframes dateHighlight { 0% { background: var(--link); color: #fff; } 100% { background: var(--system-bg); color: var(--system-text); } }

.system-msg { text-align: center; padding: 4px 60px; margin: 2px 0; }
.system-msg span { background: var(--system-bg); color: var(--system-text); padding: 4px 12px; border-radius: 8px; font-size: 12px; display: inline-block; max-width: 100%; word-break: break-word; }

.msg-row { display: flex; padding: 4px 14px; align-items: flex-end; gap: 8px; }
.msg-row.sent { flex-direction: row-reverse; }

.msg-avatar {
  width: 36px; height: 36px; border-radius: 11px; flex-shrink: 0; overflow: hidden;
  background: #c7ccd4; display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 600; color: #fff; align-self: flex-start; margin-top: 2px;
}
.msg-avatar img { width: 100%; height: 100%; object-fit: cover; }
.msg-avatar.c0 { background: #2563eb; } .msg-avatar.c1 { background: #0891b2; }
.msg-avatar.c2 { background: #7c3aed; } .msg-avatar.c3 { background: #0ea5e9; }
.msg-avatar.c4 { background: #059669; } .msg-avatar.c5 { background: #db2777; }
.msg-avatar.c6 { background: #ea580c; } .msg-avatar.c7 { background: #dc2626; }

.msg-bubble { max-width: 66%; min-width: 60px; }
.msg-sender { font-size: 12px; color: var(--text-secondary); font-weight: 500; margin-bottom: 3px; padding: 0 6px; }

.bubble-body {
  background: var(--bubble-recv); padding: 8px 12px 6px; border-radius: 14px;
  border: 1px solid var(--border);
  position: relative; box-shadow: 0 1px 2px var(--shadow);
  word-break: break-word; white-space: pre-wrap; font-size: 14px;
}
.msg-row:not(.sent) .bubble-body { border-top-left-radius: 5px; }
.msg-row.sent .bubble-body { background: var(--bubble-send); border-color: transparent; border-top-right-radius: 5px; }
.msg-text { line-height: 1.45; }

.msg-quote {
  background: var(--media-bg); border-left: 3px solid var(--accent);
  border-radius: 8px; padding: 5px 10px; margin-bottom: 6px;
  font-size: 12px; color: var(--text-secondary); line-height: 1.4;
  white-space: pre-wrap; word-break: break-word;
}
.msg-quote-sender { color: var(--accent); font-weight: 600; }

.wechat-emoji { width: 20px; height: 20px; display: inline-block; vertical-align: text-bottom; margin: 0 2px; object-fit: contain; }
.msg-time { font-size: 11px; color: var(--text-time); text-align: right; margin-top: 2px; white-space: nowrap; }

.msg-image { cursor: pointer; border-radius: 6px; max-width: 300px; max-height: 300px; display: block; object-fit: contain; background: var(--media-bg); }
.msg-image.broken { width: 200px; height: 60px; display: flex; align-items: center; justify-content: center; background: var(--media-bg); color: var(--text-secondary); font-size: 12px; border-radius: 6px; }
.msg-video { max-width: 320px; max-height: 240px; border-radius: 6px; background: #000; }
.msg-emoji { max-width: 120px; max-height: 120px; display: block; cursor: pointer; }

.msg-voice { display: flex; flex-direction: column; gap: 4px; }
.msg-voice audio { height: 32px; max-width: 240px; }
.msg-voice .voice-text { font-size: 12px; opacity: 0.8; }

.hongbao-message {
  width: 240px; max-width: 100%;
  background: linear-gradient(135deg, #e25b4a 0%, #c94535 100%);
  border-radius: 12px; padding: 14px 16px;
  display: flex; gap: 12px; align-items: center; color: #fff; white-space: normal;
}
.hongbao-icon { flex-shrink: 0; width: 32px; height: 32px; }
.hongbao-icon svg { display: block; width: 32px; height: 32px; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.1)); }
.hongbao-info { flex: 1; min-width: 0; }
.hongbao-greeting { font-size: 15px; font-weight: 500; line-height: 1.35; margin-bottom: 6px; word-break: break-word; }
.hongbao-label { font-size: 12px; opacity: 0.8; }

.chat-records { margin-top: 4px; padding: 6px 8px; background: rgba(0,0,0,0.04); border-radius: 6px; border-left: 3px solid var(--link); font-size: 13px; }
[data-theme="dark"] .chat-records { background: rgba(255,255,255,0.05); }
.chat-records .cr-title { font-size: 12px; font-weight: 600; color: var(--link); margin-bottom: 4px; }
.cr-item { padding: 3px 0; border-bottom: 1px solid rgba(0,0,0,0.05); }
.cr-item:last-child { border-bottom: none; }
.cr-item .cr-sender { font-weight: 600; font-size: 12px; }
.cr-item .cr-time { font-size: 10px; color: var(--text-secondary); margin-left: 6px; }
.cr-item .cr-content { color: var(--text-secondary); font-size: 12px; margin-top: 1px; }

/* 消息类型卡片 - 微信风格 */
.wx-card {
  max-width: 260px; padding: 11px 13px; border-radius: 12px;
  background: var(--panel-bg); border: 1px solid var(--border);
  display: flex; gap: 10px; cursor: default;
}
.wx-card-left {
  width: 38px; height: 38px; border-radius: 9px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; background: var(--tag-bg);
}
.wx-card-right { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.wx-card-title { font-size: 14px; color: var(--text); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.35; }
.wx-card-sub { font-size: 11px; color: var(--text-secondary); margin-top: 3px; }
.wx-card-footer { font-size: 11px; color: #b2b2b2; margin-top: 4px; padding-top: 4px; border-top: 1px solid rgba(0,0,0,0.05); display: flex; align-items: center; gap: 3px; }

/* 转账 - 微信绿色 */
.wx-transfer { background: #fa9e3b; border-color: transparent; color: #fff; }
.wx-transfer .wx-card-title { color: #fff; font-weight: 600; }
.wx-transfer .wx-card-sub { color: rgba(255,255,255,0.8); }
.wx-transfer .wx-card-left { background: rgba(255,255,255,0.2); color: #fff; }

/* 红包补充 */
.wx-hongbao .wx-card-sub { color: rgba(255,255,255,0.7); }

/* 位置 - 地图底色 */
.wx-location .wx-card-left { background: #d8e8d0; }

/* 名片 */
.wx-contact .wx-card-left { background: #e8e8e8; font-size: 14px; }

/* 通话 */
.wx-call .wx-card-left { background: #e8f4f8; }

a > .wx-card { cursor: pointer; transition: opacity 0.15s; }
a > .wx-card:hover { opacity: 0.85; }

[data-theme="dark"] .wx-card { background: rgba(255,255,255,0.05); border-color: rgba(255,255,255,0.08); }
[data-theme="dark"] .wx-card-left { background: rgba(255,255,255,0.08); }
[data-theme="dark"] .wx-card-footer { border-top-color: rgba(255,255,255,0.06); }
[data-theme="dark"] .wx-location .wx-card-left { background: rgba(100,160,80,0.15); }
[data-theme="dark"] .wx-contact .wx-card-left { background: rgba(255,255,255,0.08); }
[data-theme="dark"] .wx-call .wx-card-left { background: rgba(0,131,143,0.15); }

.empty-state { text-align: center; padding: 60px 20px; color: var(--text-secondary); }
.empty-state .empty-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.5; }
.empty-state .empty-text { font-size: 14px; }

.chat-footer { background: var(--bg); text-align: center; padding: 10px; font-size: 12px; color: var(--text-secondary); border-top: 1px solid var(--border); flex-shrink: 0; }
.loading-indicator { text-align: center; padding: 20px; color: var(--text-secondary); font-size: 13px; display: none; }
.loading-indicator.active { display: block; }

.lightbox { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.9); z-index: 1000; align-items: center; justify-content: center; cursor: zoom-out; }
.lightbox.active { display: flex; }
.lightbox img { max-width: 95vw; max-height: 95vh; object-fit: contain; border-radius: 4px; }
.lightbox-close { position: absolute; top: 16px; right: 20px; background: none; border: none; color: #fff; font-size: 28px; cursor: pointer; z-index: 1001; opacity: 0.7; }
.lightbox-close:hover { opacity: 1; }

@media (max-width: 600px) {
  .msg-bubble { max-width: 80%; }
  .msg-image { max-width: 220px; }
  .msg-video { max-width: 260px; }
  .msg-emoji { max-width: 100px; }
  .stat-card { min-width: 70px; padding: 8px 10px; }
  .stat-card .stat-num { font-size: 18px; }
}
`
  }

  static generateJs(): string {
    return `
(function() {
  var data = window.CHAT_DATA;
  var messages = data.messages;
  var members = {};
  data.members.forEach(function(m) { members[m.id] = m; });
  var wechatEmojis = window.WECHAT_EMOJIS || {};

  var chatBody = document.getElementById('chatBody');
  var container = document.getElementById('messagesContainer');
  var loadingEl = document.getElementById('loadingIndicator');
  var lightbox = document.getElementById('lightbox');
  var lightboxImg = document.getElementById('lightboxImg');

  var filteredMessages = messages;
  var loadedCount = 0;
  var BATCH = 50;
  var isLoading = false;

  /* ===== 消息类型分类 ===== */
  var MSG_CATS = [
    { key: 'all',      icon: '\\u{1F4AC}', label: '\\u5168\\u90E8' },
    { key: 'text',     icon: '\\u{1F4DD}', label: '\\u6587\\u672C' },
    { key: 'image',    icon: '\\u{1F5BC}\\uFE0F', label: '\\u56FE\\u7247' },
    { key: 'video',    icon: '\\u{1F3AC}', label: '\\u89C6\\u9891' },
    { key: 'voice',    icon: '\\u{1F399}\\uFE0F', label: '\\u8BED\\u97F3' },
    { key: 'emoji',    icon: '\\u{1F600}', label: '\\u8868\\u60C5' },
    { key: 'hongbao',  icon: '\\u{1F9E7}', label: '\\u7EA2\\u5305' },
    { key: 'transfer', icon: '\\u{1F4B8}', label: '\\u8F6C\\u8D26' },
    { key: 'location', icon: '\\u{1F4CD}', label: '\\u4F4D\\u7F6E' },
    { key: 'link',     icon: '\\u{1F517}', label: '\\u94FE\\u63A5' },
    { key: 'file',     icon: '\\u{1F4CE}', label: '\\u6587\\u4EF6' },
    { key: 'card',     icon: '\\u{1F464}', label: '\\u540D\\u7247' },
    { key: 'call',     icon: '\\u{1F4DE}', label: '\\u901A\\u8BDD' },
    { key: 'system',   icon: '\\u{1F4E2}', label: '\\u7CFB\\u7EDF' },
    { key: 'other',    icon: '\\u{1F4E6}', label: '\\u5176\\u4ED6' }
  ];

  function classifyMsg(msg) {
    var c = msg.content || '';
    if (msg.type === 10000 || msg.type === 266287972401) return 'system';
    if (/^\\[\\u7EA2\\u5305\\]/.test(c)) return 'hongbao';
    if (/^\\[\\u8F6C\\u8D26\\]/.test(c)) return 'transfer';
    if (/^\\[\\u56FE\\u7247\\]/.test(c)) return 'image';
    if (/^\\[\\u89C6\\u9891\\]/.test(c)) return 'video';
    if (/^\\[\\u8BED\\u97F3\\u6D88\\u606F\\]/.test(c)) return 'voice';
    if (/^\\[\\u52A8\\u753B\\u8868\\u60C5\\]/.test(c)) return 'emoji';
    if (/^\\[\\u4F4D\\u7F6E\\]/.test(c)) return 'location';
    if (/^\\[\\u94FE\\u63A5\\]/.test(c) || /^\\[\\u5C0F\\u7A0B\\u5E8F\\]/.test(c) || /^\\[\\u97F3\\u4E50\\]/.test(c) || /^\\[\\u804A\\u5929\\u8BB0\\u5F55\\]/.test(c)) return 'link';
    if (/^\\[\\u6587\\u4EF6\\]/.test(c)) return 'file';
    if (/^\\[\\u540D\\u7247\\]/.test(c)) return 'card';
    if (/^\\[\\u901A\\u8BDD\\]/.test(c)) return 'call';
    if (/^\\[\\u7FA4\\u516C\\u544A\\]/.test(c)) return 'system';
    if (/^\\[\\u5FAE\\u4FE1\\u793C\\u7269\\]/.test(c)) return 'other';
    return 'text';
  }

  /* ===== 统计 ===== */
  var typeCounts = {};
  MSG_CATS.forEach(function(cat) { typeCounts[cat.key] = 0; });
  messages.forEach(function(m) { var cat = classifyMsg(m); typeCounts[cat] = (typeCounts[cat] || 0) + 1; });
  typeCounts.all = messages.length;

  function renderStats() {
    var row = document.getElementById('statsRow');
    var stats = [
      { label: '\\u603B\\u6D88\\u606F', value: typeCounts.all },
      { label: '\\u6587\\u672C', value: typeCounts.text },
      { label: '\\u56FE\\u7247', value: typeCounts.image },
      { label: '\\u89C6\\u9891', value: typeCounts.video },
      { label: '\\u8BED\\u97F3', value: typeCounts.voice },
      { label: '\\u7EA2\\u5305', value: typeCounts.hongbao },
      { label: '\\u94FE\\u63A5', value: typeCounts.link },
      { label: '\\u7CFB\\u7EDF', value: typeCounts.system }
    ];
    var html = '';
    stats.forEach(function(s) {
      html += '<div class="stat-card"><div class="stat-num">' + s.value + '</div><div class="stat-label">' + s.label + '</div></div>';
    });
    row.innerHTML = html;
  }

  /* ===== 类型筛选按钮 ===== */
  var activeType = 'all';

  function renderTypeFilters() {
    var el = document.getElementById('typeFilters');
    var html = '';
    MSG_CATS.forEach(function(cat) {
      var count = typeCounts[cat.key] || 0;
      if (cat.key !== 'all' && count === 0) return;
      var isActive = activeType === cat.key;
      html += '<span class="type-tag' + (isActive ? ' active' : '') + '" data-type="' + cat.key + '">'
        + cat.icon + ' ' + cat.label
        + ' <span class="tag-count">' + count + '</span></span>';
    });
    el.innerHTML = html;
    el.querySelectorAll('.type-tag').forEach(function(tag) {
      tag.addEventListener('click', function() {
        activeType = this.dataset.type;
        renderTypeFilters();
        applyAllFilters();
      });
    });
  }

  /* ===== 时间范围筛选 ===== */
  var dateStart = null;
  var dateEnd = null;

  function initDateFilters() {
    var startEl = document.getElementById('filterDateStart');
    var endEl = document.getElementById('filterDateEnd');
    if (messages.length > 0) {
      var minD = toDateStr(new Date(messages[0].timestamp * 1000));
      var maxD = toDateStr(new Date(messages[messages.length - 1].timestamp * 1000));
      startEl.min = minD; startEl.max = maxD;
      endEl.min = minD; endEl.max = maxD;
    }
  }

  document.getElementById('applyDateFilter').addEventListener('click', function() {
    var sv = document.getElementById('filterDateStart').value;
    var ev = document.getElementById('filterDateEnd').value;
    dateStart = sv ? parseDateStart(sv) : null;
    dateEnd = ev ? parseDateEnd(ev) : null;
    applyAllFilters();
  });

  document.getElementById('clearDateFilter').addEventListener('click', function() {
    document.getElementById('filterDateStart').value = '';
    document.getElementById('filterDateEnd').value = '';
    dateStart = null;
    dateEnd = null;
    applyAllFilters();
  });

  function parseDateStart(s) { var p = s.split('-'); return Math.floor(new Date(+p[0], +p[1]-1, +p[2], 0,0,0).getTime() / 1000); }
  function parseDateEnd(s) { var p = s.split('-'); return Math.floor(new Date(+p[0], +p[1]-1, +p[2], 23,59,59).getTime() / 1000); }

  /* ===== 综合筛选 ===== */
  function applyAllFilters() {
    filteredMessages = messages.filter(function(m) {
      if (activeType !== 'all' && classifyMsg(m) !== activeType) return false;
      if (dateStart !== null && m.timestamp < dateStart) return false;
      if (dateEnd !== null && m.timestamp > dateEnd) return false;
      return true;
    });
    var resultEl = document.getElementById('filterResult');
    var parts = [];
    if (activeType !== 'all') {
      var found = MSG_CATS.find(function(c) { return c.key === activeType; });
      if (found) parts.push(found.icon + ' ' + found.label);
    }
    if (dateStart !== null || dateEnd !== null) parts.push('\\u65F6\\u95F4\\u8303\\u56F4\\u7B5B\\u9009\\u4E2D');
    if (parts.length > 0) {
      resultEl.textContent = '\\u7B5B\\u9009\\u6761\\u4EF6: ' + parts.join(' + ') + ' \\u2014 \\u5171 ' + filteredMessages.length + ' \\u6761\\u6D88\\u606F';
    } else {
      resultEl.textContent = '';
    }
    loadedCount = 0;
    container.innerHTML = '';
    if (filteredMessages.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">\\u{1F50D}</div><div class="empty-text">\\u6CA1\\u6709\\u7B26\\u5408\\u7B5B\\u9009\\u6761\\u4EF6\\u7684\\u6D88\\u606F</div></div>';
    } else {
      loadMore();
    }
  }

  /* ===== 面板切换 ===== */
  document.getElementById('statsToggle').addEventListener('click', function() {
    document.getElementById('statsPanel').classList.toggle('active');
  });
  document.getElementById('filterToggle').addEventListener('click', function() {
    document.getElementById('filterPanel').classList.toggle('active');
  });

  /* ===== 主题切换 ===== */
  document.getElementById('themeToggle').addEventListener('click', function() {
    var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? '' : 'dark');
  });

  /* ===== 搜索 ===== */
  var searchBar = document.getElementById('searchBar');
  var searchInput = document.getElementById('searchInput');
  var searchCountEl = document.getElementById('searchCount');

  document.getElementById('searchToggle').addEventListener('click', function() {
    searchBar.classList.toggle('active');
    dateJumpBar.classList.remove('active');
    if (searchBar.classList.contains('active')) searchInput.focus();
  });

  var searchTimer;
  searchInput.addEventListener('input', function() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(doSearch, 300);
  });

  document.getElementById('clearSearch').addEventListener('click', function() {
    searchInput.value = '';
    doSearch();
  });

  function doSearch() {
    var q = searchInput.value.trim().toLowerCase();
    var base = messages.filter(function(m) {
      if (activeType !== 'all' && classifyMsg(m) !== activeType) return false;
      if (dateStart !== null && m.timestamp < dateStart) return false;
      if (dateEnd !== null && m.timestamp > dateEnd) return false;
      return true;
    });
    if (!q) {
      filteredMessages = base;
      searchCountEl.textContent = '';
    } else {
      filteredMessages = base.filter(function(m) {
        if (m.content && m.content.toLowerCase().indexOf(q) >= 0) return true;
        var mem = members[m.sender];
        if (mem && mem.name.toLowerCase().indexOf(q) >= 0) return true;
        if (m.senderName && m.senderName.toLowerCase().indexOf(q) >= 0) return true;
        return false;
      });
      searchCountEl.textContent = filteredMessages.length + ' \\u6761\\u7ED3\\u679C';
    }
    loadedCount = 0;
    container.innerHTML = '';
    loadMore();
  }

  /* ===== 日期跳转 ===== */
  var dateJumpBar = document.getElementById('dateJumpBar');
  var dateJumpInput = document.getElementById('dateJumpInput');
  var dateJumpHint = document.getElementById('dateJumpHint');

  if (messages.length > 0) {
    var minDate = new Date(messages[0].timestamp * 1000);
    var maxDate = new Date(messages[messages.length - 1].timestamp * 1000);
    dateJumpInput.min = toDateStr(minDate);
    dateJumpInput.max = toDateStr(maxDate);
    dateJumpInput.value = toDateStr(minDate);
  }

  function toDateStr(d) { return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }

  document.getElementById('dateJumpToggle').addEventListener('click', function() {
    dateJumpBar.classList.toggle('active');
    searchBar.classList.remove('active');
    dateJumpHint.textContent = '';
  });
  document.getElementById('closeDateJump').addEventListener('click', function() { dateJumpBar.classList.remove('active'); });
  document.getElementById('dateJumpBtn').addEventListener('click', jumpToDate);
  dateJumpInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') jumpToDate(); });

  function jumpToDate() {
    var val = dateJumpInput.value;
    if (!val) { dateJumpHint.textContent = '\\u8BF7\\u9009\\u62E9\\u65E5\\u671F'; return; }
    var parts = val.split('-');
    var targetDate = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]), 0,0,0);
    var targetTs = Math.floor(targetDate.getTime() / 1000);
    var lo = 0, hi = filteredMessages.length - 1, found = -1;
    while (lo <= hi) { var mid = (lo+hi)>>1; if (filteredMessages[mid].timestamp >= targetTs) { found = mid; hi = mid-1; } else { lo = mid+1; } }
    if (found === -1) { dateJumpHint.textContent = '\\u8BE5\\u65E5\\u671F\\u4E4B\\u540E\\u65E0\\u6D88\\u606F'; return; }
    var foundDate = new Date(filteredMessages[found].timestamp * 1000);
    if (foundDate.toDateString() !== targetDate.toDateString()) {
      dateJumpHint.textContent = '\\u8BE5\\u65E5\\u671F\\u65E0\\u6D88\\u606F\\uFF0C\\u5DF2\\u8DF3\\u8F6C\\u5230\\u6700\\u8FD1: ' + foundDate.getFullYear()+'\\u5E74'+(foundDate.getMonth()+1)+'\\u6708'+foundDate.getDate()+'\\u65E5';
    } else { dateJumpHint.textContent = ''; }
    if (found >= loadedCount) {
      var targetLoad = Math.min(found + BATCH, filteredMessages.length);
      var html = '';
      for (var i = loadedCount; i < targetLoad; i++) { var prev = i > 0 ? filteredMessages[i-1] : null; html += renderMsg(filteredMessages[i], prev); }
      container.insertAdjacentHTML('beforeend', html);
      loadedCount = targetLoad;
    }
    var dividers = container.querySelectorAll('.date-divider');
    var scrollTarget = null;
    var targetDateText = fmtDate(filteredMessages[found].timestamp);
    for (var d = 0; d < dividers.length; d++) { if (dividers[d].textContent.trim() === targetDateText) { scrollTarget = dividers[d]; break; } }
    if (scrollTarget) { scrollTarget.scrollIntoView({behavior:'smooth',block:'start'}); scrollTarget.classList.add('highlight'); setTimeout(function(){scrollTarget.classList.remove('highlight');},2500); }
  }

  /* ===== 图片灯箱 ===== */
  lightbox.addEventListener('click', function() { lightbox.classList.remove('active'); });
  document.getElementById('lightboxClose').addEventListener('click', function(e) { e.stopPropagation(); lightbox.classList.remove('active'); });
  function openLightbox(src) { lightboxImg.src = src; lightbox.classList.add('active'); }
  function imgError(el) { var div = document.createElement('div'); div.className = 'msg-image broken'; div.textContent = '\\u{1F4F7} \\u56FE\\u7247'; el.replaceWith(div); }

  /* ===== 工具函数 ===== */
  function avatarColor(id) { var hash = 0; for (var i = 0; i < id.length; i++) hash = ((hash<<5)-hash)+id.charCodeAt(i); return 'c'+(Math.abs(hash)%8); }
  function decodeEntities(text) { if (!text) return ''; var d = document.createElement('textarea'); d.innerHTML = text; return d.value; }
  function esc(text) { var decoded = decodeEntities(String(text||'')); var d = document.createElement('div'); d.textContent = decoded; return d.innerHTML; }

  function renderRichText(content) {
    var text = String(content || '');
    var re = /\\[([^\\]]+)\\]/g;
    var html = ''; var lastIndex = 0; var match;
    while ((match = re.exec(text)) !== null) {
      var emojiName = match[1]; var emojiSrc = wechatEmojis[emojiName]; if (!emojiSrc) continue;
      if (match.index > lastIndex) html += esc(text.slice(lastIndex, match.index)).replace(/\\n/g, '<br>');
      html += '<img class="wechat-emoji" src="' + emojiSrc + '" alt="[' + esc(emojiName) + ']" title="' + esc(emojiName) + '">';
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) html += esc(text.slice(lastIndex)).replace(/\\n/g, '<br>');
    return html || esc(text).replace(/\\n/g, '<br>');
  }

  function xmlValue(xml, tagName) {
    if (!xml) return '';
    var re = new RegExp('<' + tagName + '>([\\\\s\\\\S]*?)<\\\\/' + tagName + '>', 'i');
    var match = re.exec(String(xml));
    if (!match) return '';
    return decodeEntities(match[1].replace(/<!\\[CDATA\\[/g, '').replace(/\\]\\]>/g, '').trim());
  }
  function appMsgType(msg) { return xmlValue(msg.rawContent, 'type') || xmlValue(msg.content, 'type'); }

  function renderHongbao(greeting) {
    var g = greeting || '\\u606D\\u559C\\u53D1\\u8D22\\uFF0C\\u5927\\u5409\\u5927\\u5229';
    return '<div class="hongbao-message"><div class="hongbao-icon"><svg viewBox="0 0 40 40" fill="none"><rect x="4" y="6" width="32" height="28" rx="4" fill="white" fill-opacity="0.3"/><rect x="4" y="6" width="32" height="14" rx="4" fill="white" fill-opacity="0.2"/><circle cx="20" cy="20" r="6" fill="white" fill-opacity="0.4"/><text x="20" y="24" text-anchor="middle" fill="white" font-size="12" font-weight="bold">\\u00A5</text></svg></div><div class="hongbao-info"><div class="hongbao-greeting">' + renderRichText(g) + '</div><div class="hongbao-label">\\u5FAE\\u4FE1\\u7EA2\\u5305</div></div></div>';
  }

  function fmtTime(ts) { var d = new Date(ts*1000); return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
  function fmtDate(ts) { var d = new Date(ts*1000); return d.getFullYear()+'\\u5E74'+(d.getMonth()+1)+'\\u6708'+d.getDate()+'\\u65E5 \\u661F\\u671F'+'\\u65E5\\u4E00\\u4E8C\\u4E09\\u56DB\\u4E94\\u516D'[d.getDay()]; }

  function renderQuote(msg) {
    if (!msg.quote || !msg.quote.content) return '';
    var who = msg.quote.sender ? esc(msg.quote.sender) + ': ' : '';
    return '<div class="msg-quote"><span class="msg-quote-sender">' + who + '</span>' + renderRichText(msg.quote.content) + '</div>';
  }

  function renderContent(msg) {
    var content = msg.content || '';
    if (appMsgType(msg) === '2001' || /^\\[\\u7EA2\\u5305\\]/.test(content)) {
      var parsedGreeting = /^\\[\\u7EA2\\u5305\\](?:\\s+([\\s\\S]*))?$/.exec(content);
      parsedGreeting = parsedGreeting ? parsedGreeting[1].trim() : '';
      var greeting = xmlValue(msg.rawContent, 'receivertitle') || xmlValue(msg.rawContent, 'sendertitle') || xmlValue(content, 'receivertitle') || xmlValue(content, 'sendertitle') || parsedGreeting;
      return renderHongbao(greeting);
    }
    if (!content) return '<em style="opacity:0.5">\\u65E0\\u5185\\u5BB9</em>';

    var imgMatch = content.match(/^\\[\\u56FE\\u7247\\]\\s+(.+)$/);
    if (imgMatch) return '<img class="msg-image" src="'+esc(imgMatch[1])+'" loading="lazy" onclick="window.__lightbox(this.src)" onerror="window.__imgError(this)">';
    if (content === '['+'\\u56FE\\u7247'+']') return '<div class="msg-image broken">\\u{1F4F7} \\u56FE\\u7247</div>';

    var vidMatch = content.match(/^\\[\\u89C6\\u9891\\]\\s+(.+)$/);
    if (vidMatch) return '<video class="msg-video" controls preload="metadata" src="'+esc(vidMatch[1])+'"></video>';
    if (content === '['+'\\u89C6\\u9891'+']') return '<div class="msg-image broken">\\u{1F3AC} \\u89C6\\u9891</div>';

    var emojiMatch = content.match(/^\\[\\u52A8\\u753B\\u8868\\u60C5\\]\\s+(.+)$/);
    if (emojiMatch) return '<img class="msg-emoji" src="'+esc(emojiMatch[1])+'" loading="lazy" onclick="window.__lightbox(this.src)" onerror="window.__imgError(this)">';
    if (content === '['+'\\u52A8\\u753B\\u8868\\u60C5'+']') return '<div class="msg-image broken">\\u{1F600} \\u8868\\u60C5</div>';

    var voiceMatch = content.match(/^\\[\\u8BED\\u97F3\\u6D88\\u606F\\]\\s+(voices\\/[^\\s]+)(?:\\s+([\\s\\S]+))?$/);
    if (voiceMatch) {
      var html = '<div class="msg-voice"><audio controls preload="metadata" src="'+esc(voiceMatch[1])+'"></audio>';
      if (voiceMatch[2]) html += '<div class="voice-text">'+esc(voiceMatch[2])+'</div>';
      return html + '</div>';
    }
    if (content === '['+'\\u8BED\\u97F3\\u6D88\\u606F'+']') return '<div class="msg-image broken">\\u{1F399}\\uFE0F \\u8BED\\u97F3</div>';

    /* 转账 - 微信橙色风格 */
    var transferMatch = content.match(/^\\[\\u8F6C\\u8D26\\]\\s+(.+)$/);
    if (transferMatch) return '<div class="wx-card wx-transfer"><div class="wx-card-left">\\u{1F4B0}</div><div class="wx-card-right"><div class="wx-card-title">'+renderRichText(transferMatch[1])+'</div><div class="wx-card-sub">\\u5FAE\\u4FE1\\u8F6C\\u8D26</div></div></div>';

    /* 链接 - 提取 URL 使其可点击 */
    var linkMatch = content.match(/^\\[\\u94FE\\u63A5\\]\\s+(.+)$/);
    if (linkMatch) {
      var linkUrl = xmlValue(msg.rawContent, 'url') || xmlValue(msg.content, 'url');
      var linkHtml = '<div class="wx-card"><div class="wx-card-left">\\u{1F517}</div><div class="wx-card-right"><div class="wx-card-title">'+esc(linkMatch[1])+'</div><div class="wx-card-footer">\\u{1F310} \\u7F51\\u9875\\u94FE\\u63A5</div></div></div>';
      if (linkUrl) linkHtml = '<a href="'+esc(linkUrl)+'" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;">' + linkHtml + '</a>';
      return linkHtml;
    }

    /* 小程序 */
    var miniappMatch = content.match(/^\\[\\u5C0F\\u7A0B\\u5E8F\\]\\s+(.+)$/);
    if (miniappMatch) {
      var miniUrl = xmlValue(msg.rawContent, 'url') || xmlValue(msg.content, 'url');
      var miniHtml = '<div class="wx-card"><div class="wx-card-left">\\u{1F4F1}</div><div class="wx-card-right"><div class="wx-card-title">'+esc(miniappMatch[1])+'</div><div class="wx-card-footer">\\u{1F4F1} \\u5C0F\\u7A0B\\u5E8F</div></div></div>';
      if (miniUrl) miniHtml = '<a href="'+esc(miniUrl)+'" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;">' + miniHtml + '</a>';
      return miniHtml;
    }

    /* 音乐 */
    var musicMatch = content.match(/^\\[\\u97F3\\u4E50\\]\\s+(.+)$/);
    if (musicMatch) {
      var musicUrl = xmlValue(msg.rawContent, 'url') || xmlValue(msg.content, 'url');
      var musicHtml = '<div class="wx-card"><div class="wx-card-left">\\u{1F3B5}</div><div class="wx-card-right"><div class="wx-card-title">'+esc(musicMatch[1])+'</div><div class="wx-card-footer">\\u{1F3B5} \\u97F3\\u4E50</div></div></div>';
      if (musicUrl) musicHtml = '<a href="'+esc(musicUrl)+'" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;">' + musicHtml + '</a>';
      return musicHtml;
    }

    /* 聊天记录 */
    var chatrecMatch = content.match(/^\\[\\u804A\\u5929\\u8BB0\\u5F55\\]\\s+(.+)$/);
    if (chatrecMatch) {
      var recUrl = xmlValue(msg.rawContent, 'url') || xmlValue(msg.content, 'url');
      var recHtml = '<div class="wx-card"><div class="wx-card-left">\\u{1F4CB}</div><div class="wx-card-right"><div class="wx-card-title">'+esc(chatrecMatch[1])+'</div><div class="wx-card-footer">\\u{1F4CB} \\u804A\\u5929\\u8BB0\\u5F55</div></div></div>';
      if (recUrl) recHtml = '<a href="'+esc(recUrl)+'" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;">' + recHtml + '</a>';
      return recHtml;
    }

    /* 文件 */
    var fileMatch = content.match(/^\\[\\u6587\\u4EF6\\]\\s+(.+)$/);
    if (fileMatch) return '<div class="wx-card"><div class="wx-card-left">\\u{1F4C4}</div><div class="wx-card-right"><div class="wx-card-title">'+esc(fileMatch[1])+'</div><div class="wx-card-footer">\\u{1F4CE} \\u6587\\u4EF6</div></div></div>';

    /* 位置 - 提取坐标生成地图链接 */
    var locMatch = content.match(/^\\[\\u4F4D\\u7F6E\\]\\s+(.+)$/);
    if (locMatch) {
      var raw = msg.rawContent || '';
      var locLat = raw.match(/(?:lat|x)\\s*=\\s*\\\"?(-?[\\d.]+)/);
      var locLng = raw.match(/(?:lng|y)\\s*=\\s*\\\"?(-?[\\d.]+)/);
      var locHtml = '<div class="wx-card wx-location"><div class="wx-card-left">\\u{1F4CD}</div><div class="wx-card-right"><div class="wx-card-title">'+esc(locMatch[1])+'</div><div class="wx-card-footer">\\u{1F4CD} \\u4F4D\\u7F6E</div></div></div>';
      if (locLat && locLng) locHtml = '<a href="https://uri.amap.com/marker?position='+locLng[1]+','+locLat[1]+'" target="_blank" rel="noopener" style="text-decoration:none;color:inherit;">' + locHtml + '</a>';
      return locHtml;
    }

    /* 名片 - 显示昵称和微信号 */
    var cardMatch = content.match(/^\\[\\u540D\\u7247\\]\\s+(.+)$/);
    if (cardMatch) {
      var cardRaw = msg.rawContent || '';
      var cardWxid = cardRaw.match(/username\\s*=\\s*\\\"([^\\\"]+)/);
      var cardDesc = cardRaw.match(/(?:(?:province|city)\\s*=\\s*\\\"([^\\\"]*)\"?)|(?:signature\\s*=\\s*\\\"([^\\\"]*)\"?)/g);
      var cardHtml = '<div class="wx-card wx-contact"><div class="wx-card-left">\\u{1F464}</div><div class="wx-card-right"><div class="wx-card-title">'+esc(cardMatch[1])+'</div>';
      if (cardWxid) cardHtml += '<div class="wx-card-sub">\\u5FAE\\u4FE1\\u53F7: '+esc(cardWxid[1])+'</div>';
      cardHtml += '</div></div>';
      return cardHtml;
    }

    /* 通话 */
    var callMatch = content.match(/^\\[\\u901A\\u8BDD\\]\\s*(.*)$/);
    if (callMatch) return '<div class="wx-card wx-call"><div class="wx-card-left">\\u{1F4DE}</div><div class="wx-card-right"><div class="wx-card-title">'+(callMatch[1] ? esc(callMatch[1]) : '\\u901A\\u8BDD')+'</div><div class="wx-card-footer">\\u{1F4DE} \\u97F3\\u89C6\\u9891\\u901A\\u8BDD</div></div></div>';

    /* 群公告 */
    var noticeMatch = content.match(/^\\[\\u7FA4\\u516C\\u544A\\]\\s+(.+)$/);
    if (noticeMatch) return '<div class="wx-card"><div class="wx-card-left">\\u{1F4E2}</div><div class="wx-card-right"><div class="wx-card-title">'+esc(noticeMatch[1])+'</div><div class="wx-card-footer">\\u{1F4E2} \\u7FA4\\u516C\\u544A</div></div></div>';

    /* 微信礼物 */
    var giftMatch = content.match(/^\\[\\u5FAE\\u4FE1\\u793C\\u7269\\]\\s+(.+)$/);
    if (giftMatch) return '<div class="wx-card"><div class="wx-card-left">\\u{1F381}</div><div class="wx-card-right"><div class="wx-card-title">'+esc(giftMatch[1])+'</div><div class="wx-card-footer">\\u{1F381} \\u5FAE\\u4FE1\\u793C\\u7269</div></div></div>';

    return '<span class="msg-text">' + renderRichText(content) + '</span>';
  }

  function renderChatRecords(records) {
    if (!records || records.length === 0) return '';
    var html = '<div class="chat-records"><div class="cr-title">\\u{1F4CB} \\u804A\\u5929\\u8BB0\\u5F55</div>';
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      html += '<div class="cr-item"><span class="cr-sender">'+esc(r.senderDisplayName)+'</span>';
      if (r.formattedTime) html += '<span class="cr-time">'+esc(r.formattedTime)+'</span>';
      html += '<div class="cr-content">'+renderRichText(r.content)+'</div></div>';
    }
    return html + '</div>';
  }

  function renderMsg(msg, prevMsg) {
    var html = '';
    if (!prevMsg || fmtDate(msg.timestamp) !== fmtDate(prevMsg.timestamp)) html += '<div class="date-divider"><span>'+fmtDate(msg.timestamp)+'</span></div>';
    if (msg.type === 10000 || msg.type === 266287972401) { html += '<div class="system-msg"><span>'+esc(msg.content||'')+'</span></div>'; return html; }
    var mem = members[msg.sender];
    var name = mem ? mem.name : (msg.senderName || msg.sender);
    var avatar = mem && mem.avatar ? mem.avatar : null;
    var isGroup = data.meta.isGroup;
    var isSend = msg.isSend;
    html += '<div class="msg-row'+(isSend?' sent':'')+'">';
    html += '<div class="msg-avatar '+avatarColor(msg.sender)+'">';
    if (avatar) { html += '<img src="'+esc(avatar)+'" onerror="this.style.display=\\'none\\';this.parentElement.textContent=\\''+esc(name.charAt(0))+'\\'"/>'; }
    else { html += esc(name.charAt(0)); }
    html += '</div>';
    html += '<div class="msg-bubble">';
    if (isGroup && !isSend) html += '<div class="msg-sender">'+esc(name)+'</div>';
    html += '<div class="bubble-body">';
    html += renderQuote(msg);
    html += renderContent(msg);
    if (msg.chatRecords) html += renderChatRecords(msg.chatRecords);
    html += '<div class="msg-time">'+fmtTime(msg.timestamp)+'</div>';
    html += '</div></div></div>';
    return html;
  }

  function loadMore() {
    if (isLoading || loadedCount >= filteredMessages.length) { loadingEl.classList.remove('active'); return; }
    isLoading = true;
    loadingEl.classList.add('active');
    requestAnimationFrame(function() {
      var end = Math.min(loadedCount + BATCH, filteredMessages.length);
      var html = '';
      for (var i = loadedCount; i < end; i++) { var prev = i > 0 ? filteredMessages[i-1] : null; html += renderMsg(filteredMessages[i], prev); }
      container.insertAdjacentHTML('beforeend', html);
      loadedCount = end;
      isLoading = false;
      if (loadedCount >= filteredMessages.length) loadingEl.classList.remove('active');
    });
  }

  chatBody.addEventListener('scroll', function() {
    if (chatBody.scrollTop + chatBody.clientHeight >= chatBody.scrollHeight - 300) loadMore();
  });

  window.__lightbox = openLightbox;
  window.__imgError = imgError;

  /* ===== 初始化 ===== */
  renderStats();
  renderTypeFilters();
  initDateFilters();
  loadMore();
})();
`
  }

  /**
   * 生成数据 JS 文件（兼容旧接口）
   */
  static generateDataJs(exportData: HtmlExportData): string {
    return `window.CHAT_DATA = ${JSON.stringify(exportData)};`
  }

  /**
   * 生成数据 JSON 文件
   */
  static generateDataJson(exportData: HtmlExportData): string {
    return JSON.stringify(exportData, null, 2)
  }

  private static buildWechatEmojiDataMap(exportData: HtmlExportData): Record<string, string> {
    const names = this.collectWechatEmojiNames(exportData)
    if (names.size === 0) return {}

    const assetMap = this.loadWechatEmojiAssetMap()
    const result: Record<string, string> = {}
    for (const name of names) {
      const filePath = assetMap.get(name)
      if (!filePath) continue
      try {
        const buffer = fs.readFileSync(filePath)
        result[name] = `data:image/png;base64,${buffer.toString('base64')}`
      } catch { }
    }
    return result
  }

  private static collectWechatEmojiNames(exportData: HtmlExportData): Set<string> {
    const names = new Set<string>()
    const collect = (text?: string | null) => {
      if (!text) return
      const re = /\[([^\]]+)\]/g
      let match: RegExpExecArray | null
      while ((match = re.exec(text)) !== null) {
        const name = match[1]?.trim()
        if (name) names.add(name)
      }
    }

    for (const msg of exportData.messages || []) {
      collect(msg.content)
      for (const record of msg.chatRecords || []) {
        collect(record.content)
      }
    }
    return names
  }

  private static loadWechatEmojiAssetMap(): Map<string, string> {
    const result = new Map<string, string>()
    for (const root of this.getWechatEmojiRoots()) {
      if (!fs.existsSync(root)) continue
      for (const dir of WECHAT_EMOJI_DIRS) {
        const fullDir = path.join(root, dir)
        if (!fs.existsSync(fullDir)) continue
        try {
          const files = fs.readdirSync(fullDir)
          for (const file of files) {
            if (!file.toLowerCase().endsWith('.png')) continue
            const name = path.basename(file, path.extname(file))
            if (!result.has(name)) {
              result.set(name, path.join(fullDir, file))
            }
          }
        } catch { }
      }
    }
    return result
  }

  private static getWechatEmojiRoots(): string[] {
    return [
      path.join(process.cwd(), 'public', 'wechat-emojis'),
      path.join(process.cwd(), 'dist', 'wechat-emojis'),
      path.join(__dirname, '..', 'public', 'wechat-emojis'),
      path.join(__dirname, '..', 'dist', 'wechat-emojis'),
      path.join(__dirname, '..', '..', 'public', 'wechat-emojis'),
      path.join(__dirname, '..', '..', 'dist', 'wechat-emojis'),
      path.join(process.resourcesPath || '', 'wechat-emojis'),
      path.join(process.resourcesPath || '', 'app.asar', 'dist', 'wechat-emojis'),
      path.join(process.resourcesPath || '', 'app.asar.unpacked', 'dist', 'wechat-emojis')
    ].filter(Boolean)
  }

  private static escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }
    return text.replace(/[&<>"']/g, m => map[m])
  }
}
