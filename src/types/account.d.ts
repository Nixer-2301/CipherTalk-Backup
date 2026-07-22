export interface AccountProfile {
  id: string
  wxid: string
  dbPath: string
  decryptKey: string
  cachePath: string
  imageXorKey: string
  imageAesKey: string
  displayName: string
  /** 微信号（自定义 ID，内存提取自 global_config） */
  wechatNumber: string
  /** 绑定手机号（内存提取自 global_config） */
  phone: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number
}

export type AccountProfileInput = Omit<
  AccountProfile,
  'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'wechatNumber' | 'phone'
> & {
  // 兼容旧调用方：未提供时由存储层归一化为空串
  wechatNumber?: string
  phone?: string
}

export type AccountProfilePatch = Partial<AccountProfileInput> & {
  displayName?: string
}
