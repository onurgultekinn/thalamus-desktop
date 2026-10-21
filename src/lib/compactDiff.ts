/**
 * Kompakt diff genişletici (H42).
 *
 * Model çıktı token'ını düşürmek için standart `git diff` başlıklarını
 * yazmaz. Biçim:
 *
 *   ```diff
 *   F src/foo.ts
 *   @42 42
 *   -const x = 1;
 *   +const x = 2;
 *   ```
 *
 * `F` → diff --git/---/+++ üçlüsü, `@a[,b] c[,d]` → `@@ -a,b +c,d @@`.
 * Genişletme deterministiktir; kullanıcıya ve yamaya standart diff gider.
 * Kayıp yok: satır içerikleri aynen taşınır (yalnız başlık kısaltılır).
 */

function expandBody(body: string): string {
  const out: string[] = [];
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('F ')) {
      const path = line.slice(2).trim();
      if (path) {
        out.push(`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`);
        continue;
      }
    }
    if (line.startsWith('@')) {
      const m = /^@(\S+)\s+(\S+)/.exec(line);
      if (m) {
        out.push(`@@ -${m[1]} +${m[2]} @@`);
        continue;
      }
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Yalnız ```diff çitleri içindeki kompakt gövdeyi genişletir. */
export function expandCompactDiff(text: string): string {
  return text.replace(/```diff\r?\n([\s\S]*?)```/g, (_m, body: string) => {
    // Yalnız KOMPAKT biçim (F satırıyla başlar) genişletilir; standart diff'e dokunma.
    if (!/^\s*F /m.test(body)) return _m;
    return '```diff\n' + expandBody(body) + '```';
  });
}
