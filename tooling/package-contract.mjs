/**
 * Контракт архива пакета (issue #3): что обязано попасть в `npm pack`, чего в нём быть не должно
 * и какие обещания `package.json` проверяются на самом архиве.
 *
 * Зачем отдельный модуль. Состав архива проверяют двое: тест `tooling/check-package.test.mjs` — что
 * правила краснеют на сломанном архиве, и релизный workflow (`release.yml` →
 * `tooling/check-package.mjs`) — что публикуется именно проверенное. Два списка разошлись бы на
 * первой же правке `files`, а ошибка в составе видна потребителю: версия в npm неизменяема, и
 * пакет без `src/cli.mjs` или без `LICENSE` уже не переписать.
 *
 * Модуль не читает файлов: он получает имена файлов архива и разобранный `package.json`. Так его
 * проверяют на синтетических списках, а тест на настоящем архиве остаётся один.
 *
 * Shebang не нужен: модуль подключается тестом и `tooling/check-package.mjs`.
 */

/** Имя пакета — часть контракта: под ним ставится пакет (`npx @dnikulshin/harness-viewer`). */
export const PACKAGE_NAME = '@dnikulshin/harness-viewer';

/**
 * Что обязано быть в архиве, чтобы потребитель запустил команду: точка входа, модули, которые она
 * импортирует, документация и лицензия.
 * @type {readonly string[]}
 */
export const REQUIRED_ENTRIES = Object.freeze([
  'LICENSE',
  'README.md',
  'package.json',
  'src/cli.mjs',
  'src/artifacts.mjs',
  'src/render.mjs',
  'src/format.mjs',
  'src/direct-run.mjs',
]);

/**
 * Чего в архиве быть не должно: тесты с фикстурами и инфраструктура репозитория. Потребителю они
 * не нужны, а фикстуры артефактов — чужой контракт тестов, который он не просил.
 * @type {readonly string[]}
 */
export const FORBIDDEN_ENTRIES = Object.freeze([
  'test/',
  'tooling/',
  '.github/',
  'node_modules/',
  'dist/',
]);

/**
 * Записи, которые npm включает в архив независимо от `files`.
 * @type {readonly string[]}
 */
const ALWAYS_INCLUDED = Object.freeze(['package.json', 'README.md', 'LICENSE']);

/**
 * Пути, которые `bin`/`exports` обещают потребителю: без них установка формально успешна, а
 * `node_modules/.bin` и импорт падают у него, а не в CI.
 * @param {Record<string, unknown>} pkg разобранный `package.json`
 * @returns {string[]} пути внутри пакета (`./` срезан), без повторов, по алфавиту
 */
export function promisedPaths(pkg) {
  /** @type {string[]} */
  const paths = [];

  const bin = pkg.bin;
  if (typeof bin === 'object' && bin !== null) {
    for (const target of Object.values(bin)) {
      if (typeof target === 'string') paths.push(target);
    }
  }

  const exports = pkg.exports;
  if (typeof exports === 'object' && exports !== null) {
    for (const [key, target] of Object.entries(exports)) {
      // Шаблонный ключ (`./fixtures/*`) конкретных файлов не обещает.
      if (key.includes('*')) continue;
      if (typeof target === 'string') {
        paths.push(target);
        continue;
      }
      if (typeof target !== 'object' || target === null) continue;
      for (const value of Object.values(target)) {
        if (typeof value === 'string') paths.push(value);
      }
    }
  }

  // `bin` и `exports` часто указывают на один файл: в находках он должен быть один раз.
  return [...new Set(paths.map((path) => path.replace(/^\.\//u, '')))].sort();
}

/**
 * Покрывает ли запись `files` путь внутри пакета.
 * @param {string} path путь внутри пакета
 * @param {readonly string[]} files записи `files` из `package.json`
 * @returns {boolean}
 */
export function coveredByFiles(path, files) {
  if (ALWAYS_INCLUDED.includes(path)) return true;
  return files.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

/**
 * Находки по составу архива.
 * @param {Iterable<string>} entries имена файлов архива без ведущего `package/`
 * @returns {string[]} проблемы; пустой список — архив полон
 */
export function archiveProblems(entries) {
  const present = new Set(entries);
  /** @type {string[]} */
  const problems = [];

  for (const path of REQUIRED_ENTRIES) {
    if (!present.has(path)) problems.push(`в архиве нет ${path} — сломан files или забыт файл`);
  }
  for (const prefix of FORBIDDEN_ENTRIES) {
    const leaked = [...present].filter((entry) => entry.startsWith(prefix));
    if (leaked.length > 0) problems.push(`в архив попало лишнее (${prefix}): ${leaked.join(', ')}`);
  }
  return problems;
}

/**
 * Находки по `files`: обязательные записи обязаны быть им покрыты, иначе архив будет неполным, а
 * `check-package` узнает об этом только на релизе.
 * @param {Record<string, unknown>} pkg разобранный `package.json`
 * @returns {string[]} проблемы; пустой список — `files` покрывает контракт
 */
export function filesProblems(pkg) {
  const files = Array.isArray(pkg.files) ? pkg.files.filter((entry) => typeof entry === 'string') : [];
  /** @type {string[]} */
  const problems = [];

  for (const path of REQUIRED_ENTRIES) {
    if (!coveredByFiles(path, files)) {
      problems.push(`files не покрывает ${path} — он не попадёт в архив`);
    }
  }
  return problems;
}

/**
 * Находки по обещаниям `package.json` архива: имя, версия, наличие файлов `bin`/`exports`.
 * @param {object} options
 * @param {Record<string, unknown>} options.pkg `package.json` из архива
 * @param {Iterable<string>} options.entries имена файлов архива без ведущего `package/`
 * @param {{ name?: string, version?: string }} [options.expected] ожидаемые имя и версия
 * @returns {string[]} проблемы; пустой список — обещания выполнены
 */
export function packageProblems({ pkg, entries, expected = {} }) {
  const present = new Set(entries);
  /** @type {string[]} */
  const problems = [];

  if (expected.name !== undefined && pkg.name !== expected.name) {
    problems.push(`в архиве имя ${String(pkg.name)}, ожидалось ${expected.name}`);
  }
  if (expected.version !== undefined && pkg.version !== expected.version) {
    problems.push(
      `в архиве версия ${String(pkg.version)}, ожидалось ${expected.version} (тег и package.json расходятся)`,
    );
  }

  for (const path of promisedPaths(pkg)) {
    if (!present.has(path)) problems.push(`package.json обещает ${path}, а в архиве его нет`);
  }

  const bin = pkg.bin;
  if (typeof bin !== 'object' || bin === null || Object.keys(bin).length === 0) {
    problems.push('package.json без bin: потребителю нечем запускать команду');
  }

  if (pkg.private === true) {
    problems.push('package.json с private: true — такой пакет npm не опубликует');
  }

  return problems;
}
