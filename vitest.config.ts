import { defineConfig } from 'vitest/config';

// Node ortamı: bu testler yalnız SAF fonksiyonları kapsar. DOM/Tauri gereken
// bileşenler burada test edilmez. localStorage kullanan modüller için
// tests/setup.ts içinde bellek içi bir vekil tanımlanır.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
  },
});
