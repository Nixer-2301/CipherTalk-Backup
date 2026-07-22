/**
 * 简单的 LRU (Least Recently Used) 缓存实现
 * 用于限制内存中缓存对象的数量，防止内存泄漏
 */
export class LRUCache<K, V> {
    private capacity: number;
    private cache: Map<K, V>;

    constructor(capacity: number) {
        this.capacity = capacity;
        this.cache = new Map();
    }

    get(key: K): V | undefined {
        if (!this.cache.has(key)) return undefined;

        // 刷新项目：先删除再添加，使其成为最新的（排在 Map 末尾）
        const value = this.cache.get(key)!;
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key: K, value: V): void {
        if (this.cache.has(key)) {
            // 如果已存在，删除旧的以便重新添加到末尾
            this.cache.delete(key);
        } else if (this.cache.size >= this.capacity) {
            // 如果达到容量上限，删除第一个项目（最久未使用的）
            // Map.keys().next().value 获取的是插入顺序最早的那个
            const firstKey = this.cache.keys().next().value;
            if (firstKey !== undefined) {
                this.cache.delete(firstKey);
            }
        }
        this.cache.set(key, value);
    }

    has(key: K): boolean {
        return this.cache.has(key);
    }

    delete(key: K): boolean {
        return this.cache.delete(key);
    }

    clear(): void {
        this.cache.clear();
    }

    get size(): number {
        return this.cache.size;
    }
}
