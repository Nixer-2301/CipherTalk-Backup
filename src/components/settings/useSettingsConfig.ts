import { useCallback, useState } from 'react'
import * as configService from '../../services/config'
import type { AccountProfile } from '../../types/account'
import { type SettingsConfig, useSettingsStore } from './settingsStore'

export function buildSettingsConfigFromStore(): SettingsConfig {
  return useSettingsStore.getState().config
}

export function useSettingsConfig() {
  const [message, setMessage] = useState<{ text: string; success: boolean } | null>(null)

  const showMessage = useCallback((text: string, success: boolean) => {
    setMessage({ text, success })
    window.setTimeout(() => setMessage(null), 3000)
  }, [])

  const loadConfig = useCallback(async () => {
    const store = useSettingsStore.getState()
    store.setLoading(true)
    try {
      const activeAccount = await configService.getActiveAccount()
      const sttLanguages = await configService.getSttLanguages()

      const config: SettingsConfig = {
        decryptKey: activeAccount?.decryptKey || await configService.getDecryptKey() || '',
        dbPath: activeAccount?.dbPath || await configService.getDbPath() || '',
        wxid: activeAccount?.wxid || await configService.getMyWxid() || '',
        cachePath: activeAccount?.cachePath || await configService.getCachePath() || '',
        imageXorKey: activeAccount?.imageXorKey || await configService.getImageXorKey() || '',
        imageAesKey: activeAccount?.imageAesKey || await configService.getImageAesKey() || '',
        displayName: activeAccount?.displayName || '',
        wechatNumber: activeAccount?.wechatNumber || '',
        phone: activeAccount?.phone || '',
        editingAccountId: activeAccount?.id || '',
        skipIntegrityCheck: await configService.getSkipIntegrityCheck(),
        autoUpdateDatabase: await configService.getAutoUpdateDatabase(),
        autoUpdateCheckInterval: await configService.getAutoUpdateCheckInterval(),
        autoUpdateMinInterval: await configService.getAutoUpdateMinInterval(),
        autoUpdateDebounceTime: await configService.getAutoUpdateDebounceTime(),

        sttLanguages: sttLanguages.length > 0 ? sttLanguages : ['zh'],
        sttModelType: await configService.getSttModelType(),
        sttMode: await configService.getSttMode(),
        sttOnlineProvider: await configService.getSttOnlineProvider(),
        sttOnlineApiKey: await configService.getSttOnlineApiKey(),
        sttOnlineBaseURL: await configService.getSttOnlineBaseURL(),
        sttOnlineModel: await configService.getSttOnlineModel(),
        sttOnlineLanguage: await configService.getSttOnlineLanguage(),
        sttOnlineTimeoutMs: await configService.getSttOnlineTimeoutMs(),
        sttOnlineMaxConcurrency: await configService.getSttOnlineMaxConcurrency(),

       aiProvider: await configService.getAiProvider(),
       aiApiKey: await configService.getAiApiKey(),
       aiModel: await configService.getAiModel(),

        diaryEnabled: await configService.getDiaryEnabled(),

       quoteStyle: await configService.getQuoteStyle(),
        exportPath: await configService.getExportPath() || '',
        exportDefaultDateRange: await configService.getExportDefaultDateRange(),
        closeToTray: await configService.getCloseToTray(),
        hardwareAccelerationEnabled: await configService.getHardwareAccelerationEnabled()
      }

      store.hydrate(config)
      return { config, activeAccount }
    } finally {
      useSettingsStore.getState().setLoading(false)
    }
  }, [])

  const reloadConfig = loadConfig

  const saveConfig = useCallback(async (): Promise<AccountProfile | null> => {
    const store = useSettingsStore.getState()
    const config = store.config
    store.setSaving(true)
    try {
      let savedAccount: AccountProfile | null = null
      const accountPayload = {
        wxid: config.wxid.trim(),
        dbPath: config.dbPath.trim(),
        decryptKey: config.decryptKey.trim(),
        cachePath: config.cachePath.trim(),
        imageXorKey: config.imageXorKey.trim(),
        imageAesKey: config.imageAesKey.trim(),
        wechatNumber: config.wechatNumber.trim(),
        phone: config.phone.trim(),
        // 优先用内存提取到的真实昵称作为展示名，否则回退到 wxid
        displayName: config.displayName.trim() || config.wxid.trim() || '未命名账号'
      }

      if (config.editingAccountId) {
        savedAccount = await configService.updateAccount(config.editingAccountId, accountPayload)
      } else if (accountPayload.wxid || accountPayload.dbPath || accountPayload.decryptKey || accountPayload.cachePath) {
        savedAccount = await configService.saveAccount(accountPayload)
      }

      if (savedAccount) {
        store.setField('editingAccountId', savedAccount.id)
      }

      if (config.exportPath) await configService.setExportPath(config.exportPath)
      await configService.setSkipIntegrityCheck(config.skipIntegrityCheck)
      await configService.setAutoUpdateDatabase(config.autoUpdateDatabase)
      await configService.setAutoUpdateCheckInterval(config.autoUpdateCheckInterval)
      await configService.setAutoUpdateMinInterval(config.autoUpdateMinInterval)
      await configService.setAutoUpdateDebounceTime(config.autoUpdateDebounceTime)
      await configService.setQuoteStyle(config.quoteStyle)
      await configService.setExportDefaultDateRange(config.exportDefaultDateRange)
      await configService.setAiProvider(config.aiProvider)
      await configService.setAiApiKey(config.aiApiKey)
      await configService.setAiModel(config.aiModel)
      await configService.setSttLanguages(config.sttLanguages)
      await configService.setSttModelType(config.sttModelType)
      await configService.setSttMode(config.sttMode)
      await configService.setSttOnlineProvider(config.sttOnlineProvider)
      await configService.setSttOnlineApiKey(config.sttOnlineApiKey)
      await configService.setSttOnlineBaseURL(config.sttOnlineBaseURL)
      await configService.setSttOnlineModel(config.sttOnlineModel)
      await configService.setSttOnlineLanguage(config.sttOnlineLanguage)
      await configService.setSttOnlineTimeoutMs(config.sttOnlineTimeoutMs)
      await configService.setSttOnlineMaxConcurrency(config.sttOnlineMaxConcurrency)
     await configService.setCloseToTray(config.closeToTray)
     await configService.setHardwareAccelerationEnabled(config.hardwareAccelerationEnabled)

      await configService.setDiaryEnabled(config.diaryEnabled)

     store.commit()
      showMessage('配置保存成功', true)
      return savedAccount
    } catch (e) {
      useSettingsStore.getState().setSaving(false)
      showMessage(`保存配置失败: ${e}`, false)
      return null
    }
  }, [showMessage])

  return { message, loadConfig, reloadConfig, saveConfig, showMessage }
}
