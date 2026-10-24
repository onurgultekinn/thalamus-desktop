/**
 * `heic2any` stub'ı.
 *
 * Gerçek paket MIT görünse de içinde **libheif (LGPL-3.0)** WASM'ı taşır.
 * Ticari/dağıtılan bir uygulamada bu bağımlılığı istemiyoruz; Vite alias'ı
 * `heic2any`'yi buraya yönlendirir, böylece LGPL kod pakete hiç girmez.
 *
 * HEIC/HEIF için lisansı güvenli yol: Windows'un kendi kodeği (HEIF Image
 * Extensions) veya kullanıcı tarafından PNG/JPG'ye dönüştürme. UI bunu
 * `preview.heicUnsupported` mesajıyla açıkça söyler.
 */

export default async function heic2any(): Promise<never> {
  throw new Error(
    'HEIC/HEIF decoder is not bundled (LGPL HEVC decoder). Convert the image to PNG/JPG or open it in Windows Photos.',
  );
}
