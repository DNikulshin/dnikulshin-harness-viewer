/**
 * «Модуль запущен как CLI, а не импортирован».
 *
 * Нужно, потому что `src/cli.mjs` одновременно CLI и модуль с чистыми функциями (их зовут тесты):
 * проверка `process.argv[1] === import.meta.filename` не работает через `bin`-ссылку пакета —
 * `argv[1]` содержит путь ссылки, а `import.meta.filename` — уже разрешённый путь файла. Поэтому
 * оба пути разрешаются `realpathSync`.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} [metaUrl] `import.meta.url` модуля
 * @param {string} [argv1] `process.argv[1]`
 * @returns {boolean}
 */
export function isDirectRun(metaUrl = import.meta.url, argv1 = process.argv[1]) {
  if (typeof metaUrl !== 'string' || typeof argv1 !== 'string' || argv1 === '') return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}
