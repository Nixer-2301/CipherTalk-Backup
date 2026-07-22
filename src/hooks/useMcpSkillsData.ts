import { useCallback, useEffect, useState } from 'react'

export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface LiveMcpServer {
  id: string
  name: string
  toolCount: number
  status: McpServerStatus
  error?: string
}

export interface LiveSkill {
  id: string
  name: string
  description: string
  builtin: boolean
}

export function useMcpSkillsData() {
  const [mcpServers, setMcpServers] = useState<LiveMcpServer[]>([])
  const [skills, setSkills] = useState<LiveSkill[]>([])
  const [busyServers, setBusyServers] = useState<Set<string>>(new Set())

  const refreshMcp = useCallback(async () => {
    try {
      const list = await window.electronAPI.mcpClient.listStatuses()
      setMcpServers(list.map(s => ({
        id: s.name,
        name: s.name,
        toolCount: s.toolCount,
        status: s.status as McpServerStatus,
        error: s.error,
      })))
    } catch {
      // Electron API unavailable (e.g. browser dev mode)
    }
  }, [])

  const refreshSkills = useCallback(async () => {
    try {
      const list = await window.electronAPI.skillManager.list()
      setSkills(list.map(s => ({
        id: s.name,
        name: s.name,
        description: s.description,
        builtin: s.builtin,
      })))
    } catch {
      // Electron API unavailable
    }
  }, [])

  const toggleServer = useCallback(async (name: string, currentStatus: McpServerStatus) => {
    if (busyServers.has(name)) return
    setBusyServers(prev => new Set(prev).add(name))
    try {
      if (currentStatus === 'connected') {
        await window.electronAPI.mcpClient.disconnect(name)
      } else {
        await window.electronAPI.mcpClient.connect(name)
      }
      await refreshMcp()
    } finally {
      setBusyServers(prev => {
        const next = new Set(prev)
        next.delete(name)
        return next
      })
    }
  }, [busyServers, refreshMcp])

  useEffect(() => {
    void refreshMcp()
    void refreshSkills()
    const timer = setInterval(() => void refreshMcp(), 4000)
    return () => clearInterval(timer)
  }, [refreshMcp, refreshSkills])

  return { mcpServers, skills, busyServers, toggleServer }
}
