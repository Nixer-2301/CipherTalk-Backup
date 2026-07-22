export interface PosterTheme {
  id: string
  name: string
  /** 使用 .poster-* 类名的原始 CSS；空字符串表示沿用默认微信样式 */
  css: string
}

export const POSTER_THEME_SCOPE = 'poster-theme-scope'

export const POSTER_THEMES: PosterTheme[] = [
  { id: 'default', name: '微信经典', css: '' },
  {
    id: 'dark',
    name: '暗夜',
    css: `
      .poster-card { background: #1c1c1e; }
      .poster-card__header { background: #2c2c2e; border-bottom-color: #3a3a3c; }
      .poster-card__title { color: #f5f5f7; }
      .poster-card__subtitle { color: #8e8e93; }
      .poster-divider span { background: rgba(255,255,255,0.14); color: #c7c7cc; }
      .poster-system { color: #8e8e93; }
      .poster-name { color: #8e8e93; }
      .poster-row.received .poster-bubble { background: #2c2c2e; color: #f0f0f2; }
      .poster-row.sent .poster-bubble { background: #0a7cff; color: #ffffff; }
      .poster-card__footer { background: #2c2c2e; border-top-color: #3a3a3c; color: #6b6b70; }
    `
  },
  {
    id: 'macaron',
    name: '马卡龙',
    css: `
      .poster-card { background: linear-gradient(160deg,#ffe3f1,#e7e9ff); }
      .poster-card__header { background: rgba(255,255,255,0.55); border-bottom-color: rgba(255,255,255,0.65); }
      .poster-card__title { color: #c2407a; }
      .poster-card__subtitle { color: #b08fb5; }
      .poster-divider span { background: rgba(194,64,122,0.28); color: #ffffff; }
      .poster-name { color: #b08fb5; }
      .poster-row.received .poster-bubble { background: #ffffff; color: #5b3a4a; }
      .poster-row.sent .poster-bubble { background: linear-gradient(135deg,#ff9ec7,#ffb38a); color: #ffffff; }
      .poster-card__footer { background: rgba(255,255,255,0.5); border-top-color: rgba(255,255,255,0.65); color: #c98fb0; }
    `
  },
  {
    id: 'paper',
    name: '简约纸',
    css: `
      .poster-card { background: #faf8f3; }
      .poster-card__header { background: #f3efe6; border-bottom-color: #e6e0d2; }
      .poster-card__title { color: #3a352b; }
      .poster-card__subtitle { color: #a59c86; }
      .poster-divider span { background: rgba(0,0,0,0.12); color: #6b6253; }
      .poster-name { color: #a59c86; }
      .poster-row.received .poster-bubble { background: #ffffff; color: #3a352b; border: 1px solid #ece6d8; }
      .poster-row.sent .poster-bubble { background: #d8e8c8; color: #38402c; }
      .poster-card__footer { background: #f3efe6; border-top-color: #e6e0d2; color: #b3a98f; }
    `
  },
  {
    id: 'ocean',
    name: '海洋',
    css: `
      .poster-card { background: linear-gradient(180deg,#e3f2fb,#cfe7f5); }
      .poster-card__header { background: #2b6f9e; border-bottom-color: #245f88; }
      .poster-card__title { color: #ffffff; }
      .poster-card__subtitle { color: #cbe6f5; }
      .poster-divider span { background: rgba(43,111,158,0.32); color: #ffffff; }
      .poster-name { color: #5a7d92; }
      .poster-row.received .poster-bubble { background: #ffffff; color: #1f3a4a; }
      .poster-row.sent .poster-bubble { background: #3a9bd4; color: #ffffff; }
      .poster-card__footer { background: #2b6f9e; border-top-color: #245f88; color: #b8d6e6; }
    `
  },
  {
    id: 'sunset',
    name: '日落',
    css: `
      .poster-card { background: linear-gradient(170deg,#fff1e0,#ffd9c7); }
      .poster-card__header { background: linear-gradient(135deg,#ff8a5c,#ff6f91); border-bottom-color: rgba(0,0,0,0.05); }
      .poster-card__title { color: #ffffff; }
      .poster-card__subtitle { color: #ffe7da; }
      .poster-divider span { background: rgba(216,90,90,0.3); color: #ffffff; }
      .poster-name { color: #b07d6a; }
      .poster-row.received .poster-bubble { background: #ffffff; color: #5a3a2e; }
      .poster-row.sent .poster-bubble { background: linear-gradient(135deg,#ff7e5f,#feb47b); color: #ffffff; }
      .poster-card__footer { background: rgba(255,255,255,0.45); border-top-color: rgba(0,0,0,0.05); color: #c98f76; }
    `
  }
]

/** 用户用 AI 生成并保存下来的自定义主题 */
export interface CustomPosterTheme {
  id: string
  name: string
  css: string
  createdAt: number
}

export const CUSTOM_THEME_PREFIX = 'custom-'

export function createCustomThemeId(): string {
  return `${CUSTOM_THEME_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

/** 移除危险/无关构造，仅保留可控的 CSS 文本 */
export function sanitizePosterCss(input: string): string {
  return String(input || '')
    .replace(/```[a-zA-Z]*\n?/g, '')
    .replace(/```/g, '')
    .replace(/<[^>]*>/g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/expression\s*\(/gi, '(')
    .replace(/url\(\s*['"]?\s*(?:https?:)?\/\/[^)]*\)/gi, 'none')
    .trim()
}

/**
 * 仅允许影响「外观」的属性。任何会改动排版/尺寸的属性（width、font-size、
 * padding、margin、display、position、flex... ）都会被剔除，使主题无法破坏布局。
 * 自带主题只用到 background / color / border-*-color，均在白名单内，不受影响。
 */
const POSTER_ALLOWED_PROPS = [
  'background',
  'color',
  'border',
  'box-shadow',
  'text-shadow',
  'opacity',
  'outline',
  'filter',
  'backdrop-filter'
]

function isAllowedPosterProp(prop: string): boolean {
  const p = prop.trim().toLowerCase()
  if (!p) return false
  return POSTER_ALLOWED_PROPS.some((allowed) => p === allowed || p.startsWith(`${allowed}-`))
}

/** 丢弃声明块里所有非外观属性，只保留白名单内的配色类属性 */
function filterPosterDeclarations(body: string): string {
  return body
    .split(';')
    .map((decl) => decl.trim())
    .filter(Boolean)
    .filter((decl) => {
      const idx = decl.indexOf(':')
      return idx > 0 && isAllowedPosterProp(decl.slice(0, idx))
    })
    .join('; ')
}

/**
 * 把任意主题 CSS 裁剪到海报作用域内：
 * - 丢弃 @media / @keyframes 等带嵌套块的规则
 * - 每个选择器前缀 .poster-theme-scope，全局选择器（body/*）因此失效
 * - 每条规则只保留白名单内的外观属性，剔除一切排版/尺寸属性
 */
export function scopePosterCss(rawCss: string): string {
  const css = sanitizePosterCss(rawCss)
  if (!css) return ''
  const rules: string[] = []
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g
  let match: RegExpExecArray | null
  while ((match = ruleRe.exec(css))) {
    const selector = match[1].trim()
    const rawBody = match[2].trim()
    if (!selector || !rawBody || selector.startsWith('@')) continue
    const body = filterPosterDeclarations(rawBody)
    if (!body) continue
    const scoped = selector
      .split(',')
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => `.${POSTER_THEME_SCOPE} ${part}`)
      .join(', ')
    if (scoped) rules.push(`${scoped} { ${body} }`)
  }
  return rules.join('\n')
}
