import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { Check, ChevronDown } from '@gravity-ui/icons'
import './Select.scss'

export interface SelectOption<T extends string | number = string> {
  value: T
  label: ReactNode
  description?: ReactNode
  /** 展开列表中的自定义渲染内容（用于视觉预览型选项），提供后取代 label/description */
  content?: ReactNode
  disabled?: boolean
}

interface SelectProps<T extends string | number = string> {
  options: readonly SelectOption<T>[]
  value: T
  onChange: (value: T) => void
  placeholder?: string
  /** 展开后选项的排布方向，默认纵向列表 */
  layout?: 'vertical' | 'horizontal'
  /** 可编辑模式：触发器变成文本输入框，允许填写列表以外的自定义值 */
  editable?: boolean
  adornment?: ReactNode
  className?: string
  style?: CSSProperties
}

function Select<T extends string | number = string>({
  options,
  value,
  onChange,
  placeholder = '请选择',
  layout = 'vertical',
  editable = false,
  adornment,
  className = '',
  style
}: SelectProps<T>) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const listId = useId()
  const [triggerH, setTriggerH] = useState(0)
  const [listH, setListH] = useState(0)

  // 测量触发器与列表高度 —— 盒子靠显式高度才能平滑「生长」
  useLayoutEffect(() => {
    const listEl = listRef.current
    setTriggerH(triggerRef.current?.offsetHeight ?? 0)
    if (!listEl) {
      setListH(0)
      return
    }

    const maxListHeight = Number.parseFloat(getComputedStyle(listEl).maxHeight)
    const visibleListHeight = Number.isFinite(maxListHeight)
      ? Math.min(listEl.scrollHeight, maxListHeight)
      : listEl.offsetHeight
    setListH(visibleListHeight)
  }, [options, layout, value, open])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const setTriggerRef = (el: HTMLElement | null) => { triggerRef.current = el }
  const selected = options.find((o) => o.value === value)
  const inputValue = value != null ? String(value) : ''
  const displayText = selected?.label
    ?? (value != null && String(value) !== '' ? String(value) : placeholder)
  const hasCustomValue = editable
    && value != null && String(value) !== ''
    && !options.some((o) => o.value === value)

  const classes = [
    'glass-select',
    `glass-select--${layout}`,
    editable ? 'glass-select--editable' : '',
    open ? 'open' : '',
    className
  ].filter(Boolean).join(' ')
  const boxHeight = triggerH ? (open ? triggerH + listH : triggerH) : undefined

  return (
    <div
      className={classes}
      style={{ ...style, height: triggerH || undefined }}
      ref={rootRef}
    >
      <div className="glass-select-box" style={{ height: boxHeight }}>
        {editable ? (
          <div className="glass-select-trigger glass-select-trigger--editable" ref={setTriggerRef}>
            <input
              type="text"
              role="combobox"
              className="glass-select-input"
              value={inputValue}
              placeholder={placeholder}
              autoComplete="off"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              onChange={(e) => {
                onChange(e.target.value as T)
                setOpen(true)
              }}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setOpen(true)
                }
                if (e.key === 'Enter') {
                  const matched = options.find((option) => (
                    !option.disabled && String(option.value) === e.currentTarget.value
                  ))
                  if (matched) onChange(matched.value)
                  setOpen(false)
                }
              }}
            />
            {adornment && (
              <div className="glass-select-adornment" aria-hidden="true">
                {adornment}
              </div>
            )}
            <button
              type="button"
              className="glass-select-toggle"
              tabIndex={-1}
              aria-label={open ? '收起选项' : '展开选项'}
              aria-expanded={open}
              aria-controls={listId}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpen((v) => !v)}
            >
              <ChevronDown width={16} height={16} className="glass-select-arrow" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="glass-select-trigger"
            ref={setTriggerRef}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="glass-select-value">{displayText}</span>
            {adornment && (
              <span className="glass-select-adornment" aria-hidden="true">
                {adornment}
              </span>
            )}
            <ChevronDown width={16} height={16} className="glass-select-arrow" />
          </button>
        )}
        <div
          id={listId}
          className="glass-select-list"
          ref={listRef}
          role="listbox"
          aria-hidden={!open}
        >
          {options.map((option, index) => (
            <button
              key={String(option.value)}
              type="button"
              role="option"
              aria-selected={option.value === value}
              disabled={option.disabled}
              tabIndex={open ? 0 : -1}
              style={{ ['--i']: index } as CSSProperties}
              className={[
                'glass-select-option',
                option.value === value ? 'is-selected' : '',
                option.content ? 'has-content' : ''
              ].filter(Boolean).join(' ')}
              onClick={() => {
                if (option.disabled) return
                onChange(option.value)
                setOpen(false)
              }}
            >
              {option.content ?? (
                <span className="glass-select-option-main">
                  <span className="glass-select-option-label">{option.label}</span>
                  {option.description && (
                    <span className="glass-select-option-desc">{option.description}</span>
                  )}
                </span>
              )}
              {option.value === value && (
                <Check width={15} height={15} className="glass-select-option-check" />
              )}
            </button>
          ))}
          {hasCustomValue && (
            <button
              type="button"
              className="glass-select-option glass-select-option--custom is-selected"
              tabIndex={open ? 0 : -1}
              style={{ ['--i']: options.length } as CSSProperties}
              onClick={() => setOpen(false)}
            >
              <span className="glass-select-option-main">
                <span className="glass-select-option-label">
                  使用自定义值：{String(value)}
                </span>
              </span>
              <Check width={15} height={15} className="glass-select-option-check" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default Select
