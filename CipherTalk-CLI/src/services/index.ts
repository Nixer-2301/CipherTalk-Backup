import { advancedService } from './advancedService.js'
import { dataService } from './dataService.js'
import { keyService } from './keyService.js'
import type { ServiceRegistry } from './types.js'

export function createDefaultServices(): ServiceRegistry {
  return {
    data: dataService,
    key: keyService,
    advanced: advancedService
  }
}
