/**
 * 插件统一 UI 组件样式库（见 PLUGIN_SYSTEM_PLAN.md §6）。
 *
 * 由 PluginHost 在握手时注入插件页，全部取值宿主主题变量，
 * 观感与宿主 HeroUI 控件一致，暗色模式自动跟随。
 * 插件侧用法：<button class="ct-btn ct-btn-primary">、<select class="ct-select">、
 * <label class="ct-switch"><input type="checkbox"><span></span></label> 等。
 */
export const PLUGIN_UI_KIT_CSS = `
/* ===== 基础 ===== */
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.6;
  background: var(--bg-primary);
  color: var(--text-primary);
  -webkit-font-smoothing: antialiased;
}

/* ===== 排版 ===== */
.ct-title { font-size: 16px; font-weight: 600; margin: 0 0 4px; color: var(--text-primary); }
.ct-hint { font-size: 13px; color: var(--text-secondary); }
.ct-label { display: block; font-size: 13px; font-weight: 500; color: var(--text-primary); margin-bottom: 6px; }

/* ===== 按钮 ===== */
.ct-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: var(--border-radius, 9999px);
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
  user-select: none;
}
.ct-btn:hover:not(:disabled) { background: var(--bg-hover); }
.ct-btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ct-btn:disabled { opacity: 0.5; cursor: default; }
.ct-btn-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #fff;
}
.ct-btn-primary:hover:not(:disabled) { background: var(--accent); opacity: 0.9; }
.ct-btn-ghost { background: transparent; border-color: transparent; }
.ct-btn-ghost:hover:not(:disabled) { background: var(--bg-hover); }
.ct-btn-danger { background: transparent; border-color: var(--danger, #ef4444); color: var(--danger, #ef4444); }
.ct-btn-danger:hover:not(:disabled) { background: var(--danger, #ef4444); color: #fff; }
.ct-btn-block { display: flex; width: 100%; }

/* ===== 输入框 / 文本域 ===== */
.ct-input, .ct-textarea {
  width: 100%;
  padding: 8px 14px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.ct-input::placeholder, .ct-textarea::placeholder { color: var(--text-tertiary); }
.ct-input:focus, .ct-textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 20%, transparent);
}
.ct-textarea { resize: vertical; min-height: 80px; }

/* ===== 下拉框（原生 select 统一皮肤） ===== */
.ct-select {
  width: 100%;
  padding: 8px 36px 8px 14px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  background-color: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  appearance: none;
  -webkit-appearance: none;
  background-image: url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.ct-select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 20%, transparent);
}
/* 注意：ct-select 的弹出列表不在插件页渲染——SDK 会接管点击，
   由宿主用应用内的 Select/ListBox 组件（与设置页同款）弹出并回传结果。 */

/* ===== 开关 =====
   用法：<label class="ct-switch"><input type="checkbox"><span></span> 文案</label> */
.ct-switch {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  font-size: 14px;
  color: var(--text-primary);
  user-select: none;
}
.ct-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.ct-switch span {
  position: relative;
  width: 40px;
  height: 24px;
  flex-shrink: 0;
  border-radius: 9999px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  transition: background 0.2s ease, border-color 0.2s ease;
}
.ct-switch span::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 9999px;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  transition: transform 0.2s ease;
}
.ct-switch input:checked + span { background: var(--accent); border-color: var(--accent); }
.ct-switch input:checked + span::after { transform: translateX(16px); }
.ct-switch input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
.ct-switch input:disabled + span { opacity: 0.5; }

/* ===== 复选框 ===== */
.ct-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.ct-checkbox input {
  width: 16px;
  height: 16px;
  accent-color: var(--accent);
  cursor: pointer;
}

/* ===== 卡片 / 分隔 ===== */
.ct-card {
  border: 1px solid var(--border-color);
  border-radius: 16px;
  background: var(--bg-secondary);
  padding: 16px;
}
.ct-divider { border: none; border-top: 1px solid var(--border-color); margin: 16px 0; }

/* ===== 标签 ===== */
.ct-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 10px;
  border-radius: 9999px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 12px;
  line-height: 1.6;
}
.ct-chip-accent { border-color: var(--accent); color: var(--accent); background: var(--primary-light, transparent); }

/* ===== 滚动条与代码 ===== */
.ct-scroll { overflow: auto; }
.ct-scroll::-webkit-scrollbar { width: 8px; height: 8px; }
.ct-scroll::-webkit-scrollbar-thumb { background: var(--border-color); border-radius: 9999px; }
.ct-code {
  padding: 10px 12px;
  border-radius: 10px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ===== 弹窗（原生 <dialog class="ct-dialog">，showModal()/close() 即可） ===== */
.ct-dialog {
  border: 1px solid var(--border-color);
  border-radius: 20px;
  background: var(--bg-primary);
  color: var(--text-primary);
  padding: 24px;
  max-width: min(440px, calc(100vw - 48px));
  box-shadow: var(--shadow-md, 0 18px 40px rgba(0, 0, 0, 0.24));
}
.ct-dialog::backdrop { background: rgba(0, 0, 0, 0.4); }
.ct-dialog-title { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
.ct-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }

/* ===== 下拉菜单（原生 <details class="ct-menu">，无需 JS） =====
   <details class="ct-menu"><summary class="ct-btn">操作</summary>
     <div class="ct-menu-panel"><button class="ct-menu-item">…</button></div></details> */
.ct-menu { position: relative; display: inline-block; }
.ct-menu summary { list-style: none; }
.ct-menu summary::-webkit-details-marker { display: none; }
.ct-menu-panel {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 180px;
  padding: 6px;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--bg-primary);
  box-shadow: var(--shadow-md, 0 12px 32px rgba(0, 0, 0, 0.18));
  z-index: 50;
}
.ct-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: var(--text-primary);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.ct-menu-item:hover { background: var(--bg-hover); }

/* ===== Tabs（配合少量 JS 切 .active） ===== */
.ct-tabs {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border-radius: 9999px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
}
.ct-tab {
  padding: 6px 16px;
  border: none;
  border-radius: 9999px;
  background: transparent;
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.ct-tab:hover:not(.active) { color: var(--text-primary); }
.ct-tab.active { background: var(--bg-primary); color: var(--text-primary); box-shadow: var(--shadow-sm, 0 1px 3px rgba(0,0,0,0.1)); }

/* ===== 进度条（原生 <progress class="ct-progress">） ===== */
.ct-progress {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 8px;
  border: none;
  border-radius: 9999px;
  overflow: hidden;
  background: var(--bg-tertiary);
}
.ct-progress::-webkit-progress-bar { background: var(--bg-tertiary); }
.ct-progress::-webkit-progress-value { background: var(--accent); border-radius: 9999px; transition: width 0.2s ease; }

/* ===== 加载中 ===== */
.ct-spinner {
  display: inline-block;
  width: 18px;
  height: 18px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent);
  border-radius: 9999px;
  animation: ct-spin 0.8s linear infinite;
}
@keyframes ct-spin { to { transform: rotate(360deg); } }
.ct-skeleton {
  border-radius: 10px;
  background: linear-gradient(90deg, var(--bg-secondary) 25%, var(--bg-hover) 50%, var(--bg-secondary) 75%);
  background-size: 200% 100%;
  animation: ct-shimmer 1.4s ease infinite;
  color: transparent;
  user-select: none;
}
@keyframes ct-shimmer { to { background-position: -200% 0; } }

/* ===== 徽标 / 状态点 ===== */
.ct-badge {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 9999px;
  background: var(--accent);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.6;
}
.ct-dot { display: inline-block; width: 8px; height: 8px; border-radius: 9999px; background: var(--accent); }
.ct-dot-success { background: var(--success, #22c55e); }
.ct-dot-danger { background: var(--danger, #ef4444); }

/* ===== 列表 ===== */
.ct-list { display: flex; flex-direction: column; border: 1px solid var(--border-color); border-radius: 16px; overflow: hidden; }
.ct-list-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
}
.ct-list-item + .ct-list-item { border-top: 1px solid var(--border-color); }
.ct-list-item:hover { background: var(--bg-hover); }

/* ===== 空状态 ===== */
.ct-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 24px;
  border: 1px dashed var(--border-color);
  border-radius: 16px;
  color: var(--text-tertiary);
  font-size: 13px;
}

/* ===== 表格（DataTable 组件复用，也可直接 <table class="ct-table">） ===== */
.ct-table-wrap { border: 1px solid var(--border-color); border-radius: 16px; overflow: auto; }
.ct-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ct-table th, .ct-table td { padding: 9px 14px; text-align: left; white-space: nowrap; }
.ct-table thead th {
  color: var(--text-secondary);
  font-weight: 600;
  background: var(--bg-secondary);
  position: sticky;
  top: 0;
  user-select: none;
}
.ct-table tbody tr { border-top: 1px solid var(--border-color); }
.ct-table tbody tr:hover { background: var(--bg-hover); }
.ct-th-sortable { cursor: pointer; }
.ct-th-sortable:hover { color: var(--text-primary); }
.ct-th-arrow { margin-left: 4px; font-size: 11px; opacity: 0.6; }
.ct-pagination {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

/* ===== 柱状图（BarChart 组件；纯 flex，柱体取主题强调色，响应式无变形） ===== */
.ct-chart { display: flex; align-items: flex-end; gap: 6px; }
.ct-chart-col {
  flex: 1 1 0;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
}
.ct-chart-bar {
  width: 60%;
  min-height: 2px;
  border-radius: 4px 4px 0 0;
  background: var(--accent);
  transition: opacity 0.15s ease;
}
.ct-chart-col:hover .ct-chart-bar { opacity: 0.8; }
.ct-chart-value { font-size: 11px; color: var(--text-secondary); margin-bottom: 2px; }
.ct-chart-label {
  max-width: 100%;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-tertiary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`
