// Node ortamında localStorage yok; saf fonksiyonların bir kısmı ona bağlı
// olduğu için süreç başına bellek içi bir vekil kuruyoruz. Testler arasında
// `beforeEach` ile temizlenir (bkz. tests/helpers.ts).
class MemoryStorage {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  get length(): number {
    return this.map.size;
  }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', {
  value: storage,
  writable: true,
  configurable: true,
});
