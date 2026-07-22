import { useCallback } from 'react'
import { toast } from '@heroui/react'

export function useTopToast() {
  const showTopToast = useCallback((text: string, success = true) => {
    if (success) toast.success(text, { timeout: 2000 })
    else toast.danger(text, { timeout: 2000 })
  }, [])

  return {
    showTopToast
  }
}
