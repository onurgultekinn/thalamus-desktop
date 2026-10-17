/**
 * CAD renderer stub'ı.
 *
 * `@file-viewer/preset-all`, CAD renderer'ını (`@file-viewer/renderer-cad`)
 * statik olarak import eder; o paket de AGPL-3.0 runtime'ı (@flyfish-dev/cad-viewer,
 * dwf-viewer) çeker. Ticari kapalı-kaynak uygulamada AGPL kodu paketlenemeyeceği
 * için **Vite alias** ile `@file-viewer/renderer-cad` bu stub'a yönlendirilir
 * (bkz. vite.config.ts). Böylece preset-all'ın geri kalan tüm Apache-2.0
 * renderer'ları çalışır; yalnız CAD devre dışı kalır.
 */
export const cadRenderer = {
  id: 'cad-disabled',
  label: 'CAD (disabled in this build)',
  definitions: [],
  handlers: [],
};
