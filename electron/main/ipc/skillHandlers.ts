import { ipcMain } from 'electron'
import { skillManagerService, setUserSkillsCachePath } from '../../services/skillManagerService'
import type { MainProcessContext } from '../context'

export function registerSkillHandlers(ctx: MainProcessContext): void {
  const cacheBasePath = ctx.getConfigService()?.getCacheBasePath()
  if (cacheBasePath) setUserSkillsCachePath(cacheBasePath)

  ipcMain.handle('skillManager:list', async () => {
    return skillManagerService.listSkills()
  })

  ipcMain.handle('skillManager:readContent', async (_, skillName: string) => {
    return skillManagerService.readSkillContent(skillName)
  })

  ipcMain.handle('skillManager:listFiles', async (_, skillName: string) => {
    return skillManagerService.listSkillFiles(skillName)
  })

  ipcMain.handle('skillManager:readFile', async (_, skillName: string, filePath: string) => {
    return skillManagerService.readSkillFile(skillName, filePath)
  })

  ipcMain.handle('skillManager:updateContent', async (_, skillName: string, content: string) => {
    return skillManagerService.updateSkillContent(skillName, content)
  })

  ipcMain.handle('skillManager:exportZip', async (_, skillName: string) => {
    return skillManagerService.exportSkillZip(skillName)
  })

  ipcMain.handle('skillManager:importZip', async (_, zipPath: string) => {
    return skillManagerService.importSkillZip(zipPath)
  })

  ipcMain.handle('skillManager:delete', async (_, skillName: string) => {
    return skillManagerService.deleteSkill(skillName)
  })

  ipcMain.handle('skillManager:create', async (_, skillName: string, content: string) => {
    return skillManagerService.createSkill(skillName, content)
  })
}
