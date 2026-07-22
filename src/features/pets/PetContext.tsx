import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

export type CurrentPet = {
  slug: string
  displayName: string
  spriteUrl: string
}

const PetContext = createContext<CurrentPet | null>(null)

/** 当前选中的宠物（未选或加载失败时为 null），消息流式指示器/页脚共用 */
export function useCurrentPet(): CurrentPet | null {
  return useContext(PetContext)
}

export function useCurrentPetLoader(): CurrentPet | null {
  const [pet, setPet] = useState<CurrentPet | null>(null)

  const load = useCallback(async () => {
    try {
      const slug = (await window.electronAPI.config.get('petCurrent')) as string | undefined
      if (!slug) {
        setPet(null)
        return
      }
      const [sprite, installed] = await Promise.all([
        window.electronAPI.pet.getSprite(slug),
        window.electronAPI.pet.listInstalled(),
      ])
      if (!sprite.success || !sprite.dataUrl) {
        setPet(null)
        return
      }
      const meta = installed.pets?.find((item) => item.slug === slug)
      setPet({ slug, displayName: meta?.displayName ?? slug, spriteUrl: sprite.dataUrl })
    } catch {
      setPet(null)
    }
  }, [])

  useEffect(() => {
    void load()
    return window.electronAPI.config.onChanged(({ key }) => {
      if (key === 'petCurrent') void load()
    })
  }, [load])

  return pet
}

export function CurrentPetProvider({ children }: { children: ReactNode }) {
  const pet = useCurrentPetLoader()
  return <PetContext.Provider value={pet}>{children}</PetContext.Provider>
}
