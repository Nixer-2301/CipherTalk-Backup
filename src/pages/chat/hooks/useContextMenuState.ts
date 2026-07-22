import { useCallback, useState } from 'react'
import type { ContextMenuState } from '../types'

export function useContextMenuState() {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const closeContextMenu = useCallback(() => {
    setContextMenu(null)
  }, [])

  return {
    contextMenu,
    setContextMenu,
    closeContextMenu
  }
}
