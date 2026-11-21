/**
 * Проверка архива перед публикацией (issue #3).
 *
 * Зачем. `npm publish` необратим: версию нельзя перезаписать, ошибку в составе архива потребитель
 * видит первым. Поэтому `release.yml` публикует **не репозиторий, а собранный `npm pack` архив**, и
 * между сборкой и публикацией стоит эта проверка: состав (`files`), файлы, обещанные `bin`,
 * совпадение версии с тегом, отсутствие тестов и `tooling/`. Находки печатаются списком, код выхода
 * `1` останавливает workflow до публикации.
 *
 * Инфраструктура репозитория, а не часть пакета: в `files` её нет и потребителю она не поставляется.
 *
 * Использование:
 * ```
 * node tooling/check-package.mjs <архив.tgz> [--tag vX.Y.Z] [--package <package.json>]
 * ```
 * `--tag` сверяет версию в `package.json` архива с тегом (`v` отбрасывается): тег — контракт
 * потребителя, и расхождение означало бы «по тегу ставится другой код». `--package` добавляет
 * сверку `files` из репозитория с контрактом: архив собирается из `files`, и запись, забытая там,
 * даёт неполный пакет при зелёной проверке самого архива.
 *
 * Коды выхода: `0` — архив прошёл проверку; `1` — есть находки; `2` — ошибка использования или
 * чтения архива.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { isDirectRun } from '../src/direct-run.mjs';
import {
  PACKAGE_NAME,
  REQUIRED_ENTRIES,
  archiveProblems,
  filesProblems,
  packageProblems,
} from './package-contract.mjs';

/**
 * Имена файлов архива без ведущего `package/`.
 * @param {string} file
 * @returns {string[]}
 */
export function archiveEntries(file) {
  const listing = execFileSync('tar', ['-tzf', file], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line !== 'package/')
    .map((line) => line.replace(/^package\//u, ''));
}

/**
 * `package.json` из архива — то, что получит потребитель, а не то, что лежит в репозитории.
 * @param {string} file
 * @returns {Record<string, any>}
 */
export function archivePackage(file) {
  const text = execFileSync('tar', ['-xOzf', file, 'package/package.json'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(text);
}

/**
 * `package.json` из репозитория: по нему собирается архив.
 * @param {string} file
 * @returns {Record<string, any>}
 */
export function repositoryPackage(file) {
  if (!existsSync(file)) throw new Error(`package.json не найден: ${file}`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Все находки: `files` репозитория, состав архива и обещания его `package.json`.
 * @param {object} options
 * @param {string} options.file путь к архиву
 * @param {string|null} [options.tag] тег релиза (`vX.Y.Z`); `null` — без сверки версии
 * @param {string|null} [options.packageFile] путь к `package.json` репозитория; `null` — без сверки `files`
 * @returns {string[]}
 */
export function checkArchive({ file, tag = null, packageFile = null }) {
  if (!existsSync(file)) throw new Error(`архив не найден: ${file}`);

  const entries = archiveEntries(file);
  const pkg = archivePackage(file);
  const expected = {
    name: PACKAGE_NAME,
    ...(tag === null ? {} : { version: tag.replace(/^v/u, '') }),
  };

  /** @type {string[]} */
  const problems = [];
  if (packageFile !== null) problems.push(...filesProblems(repositoryPackage(packageFile)));
  problems.push(...archiveProblems(entries));
  problems.push(...packageProblems({ pkg, entries, expected }));
  return problems;
}

/**
 * Разбор аргументов: архив обязателен, `--tag` и `--package` — флагами.
 * @param {string[]} argv
 * @returns {{ file: string, tag: string|null, packageFile: string|null }}
 */
export function parseArgs(argv) {
  /** @type {string|null} */
  let file = null;
  /** @type {string|null} */
  let tag = null;
  /** @type {string|null} */
  let packageFile = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--tag' || arg === '--package') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(
          `${arg}: ожидается ${arg === '--tag' ? 'vX.Y.Z' : 'путь к package.json'}`,
        );
      }
      if (arg === '--tag') tag = value;
      else packageFile = resolve(value);
      index += 1;
      continue;
    }
    if (arg === undefined || arg.startsWith('--')) {
      throw new Error(`неизвестный аргумент: ${arg ?? ''}`);
    }
    if (file !== null) throw new Error(`лишний аргумент: ${arg}`);
    file = resolve(arg);
  }

  if (file === null) {
    throw new Error(
      'использование: check-package <архив.tgz> [--tag vX.Y.Z] [--package package.json]',
    );
  }
  return { file, tag, packageFile };
}

/**
 * CLI.
 * @param {string[]} argv
 * @returns {number} код выхода
 */
function main(argv) {
  /** @type {{ file: string, tag: string|null, packageFile: string|null }} */
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`check-package: ${error instanceof Error ? error.message : error}\n`);
    return 2;
  }

  /** @type {string[]} */
  let problems;
  try {
    problems = checkArchive(args);
  } catch (error) {
    process.stderr.write(`check-package: ${error instanceof Error ? error.message : error}\n`);
    return 2;
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`check-package: ${problem}\n`);
    process.stderr.write(
      `check-package: архив не готов к публикации — правьте files/package.json ` +
        `(обязательных записей ${REQUIRED_ENTRIES.length})\n`,
    );
    return 1;
  }

  process.stdout.write(
    `check-package: ${args.file} — состав в порядке (${REQUIRED_ENTRIES.length} записей контракта)\n`,
  );
  return 0;
}

if (isDirectRun(import.meta.url)) process.exitCode = main(process.argv.slice(2));
