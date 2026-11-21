#!/usr/bin/env node
/**
 * `harness-viewer` — read-only просмотрщик артефактов `@dnikulshin/harness` (ADR 0006/0013
 * в `dev-harness`).
 *
 * Что делает: читает дерево `<root>/.pi/artifacts/**` по именам и полям Приложения A
 * (`state.json`, `gates.<n>.json`, `decision.<n>.json`, `escalation.json`, `metrics.json`,
 * `manifest.<n>.json`, `evidence/`) и собирает одну самодостаточную страницу: список циклов,
 * состояние, причина остановки, гейты, пакет `evidence` с диффом, отчёты агентов.
 *
 * Чего не делает — по построению: не пишет в каталог артефактов, не запускает гейты, не двигает
 * стадии, не пересчитывает вердикты, не поднимает сервер, не требует сети и рантайма агента.
 * Единственный побочный эффект — файл страницы по явному `--out`.
 *
 * Использование:
 * ```
 * harness-viewer render --out viewer.html [--root <проект>] [--artifacts <каталог>]
 *                                             [--max-diff-bytes N]
 * ```
 * `--root` по умолчанию — текущий каталог, `--artifacts` — `<root>/.pi/artifacts`.
 *
 * Коды выхода: `0` — страница записана (даже если часть файлов не прочиталась: ошибка видна на
 * странице); `1` — каталога артефактов нет или он недоступен, страница не пишется; `2` — ошибка
 * использования (неизвестный флаг, нет `--out`).
 *
 * Shebang нужен: файл запускается как `bin` пакета.
 */
import { mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isDirectRun } from './direct-run.mjs';
import { scanArtifacts } from './artifacts.mjs';
import { renderPage } from './render.mjs';

/** Подсказка по флагам: печатается при ошибке использования и по `--help`. */
const USAGE = [
  'Использование: harness-viewer render --out <файл> [--root <каталог>] [--artifacts <каталог>]',
  '                                          [--max-diff-bytes <число>]',
  '',
  '  --out             куда записать страницу (обязателен: в каталог артефактов не пишем)',
  '  --root            корень проекта, по умолчанию текущий каталог',
  '  --artifacts       каталог артефактов, по умолчанию <root>/.pi/artifacts',
  '  --max-diff-bytes  сколько байт диффа показать, по умолчанию 200000',
].join('\n');

/**
 * @typedef {object} Options
 * @property {string} out
 * @property {string} root
 * @property {string} artifacts
 * @property {number} maxDiffBytes
 */

/**
 * Разбор аргументов. Неизвестный флаг — ошибка, а не игнор: опечатка в `--out` иначе записала бы
 * страницу не туда, а `--artifact` молча оставил бы путь по умолчанию.
 * @param {string[]} argv
 * @param {{ cwd?: string }} [context]
 * @returns {{ options: Options|null, error: string|null, help: boolean }}
 */
export function parseArgs(argv, { cwd = process.cwd() } = {}) {
  /** @type {Record<string, string>} */
  const values = {};
  let help = false;
  let command = null;
  const args = argv.filter((arg) => arg !== '');

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (!arg.startsWith('-') && command === null) {
      command = arg;
      continue;
    }
    const known = ['--out', '--root', '--artifacts', '--max-diff-bytes'];
    if (!known.includes(arg)) {
      return { options: null, error: `неизвестный аргумент: ${arg}`, help: false };
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith('--')) {
      return { options: null, error: `${arg}: ожидается значение`, help: false };
    }
    values[arg] = next;
    index += 1;
  }

  if (help) return { options: null, error: null, help: true };
  if (command !== null && command !== 'render') {
    return { options: null, error: `неизвестная команда: ${command}`, help: false };
  }

  const out = values['--out'];
  if (out === undefined || out.trim() === '') {
    return { options: null, error: '--out обязателен: страница пишется только по явному пути', help: false };
  }

  const maxDiffRaw = values['--max-diff-bytes'];
  let maxDiffBytes = 200_000;
  if (maxDiffRaw !== undefined) {
    const parsed = Number(maxDiffRaw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      return { options: null, error: '--max-diff-bytes: ожидается целое число ≥ 0', help: false };
    }
    maxDiffBytes = parsed;
  }

  const root = resolve(cwd, values['--root'] ?? '.');
  const artifacts = resolve(root, values['--artifacts'] ?? join('.pi', 'artifacts'));
  return {
    options: { out: resolve(cwd, out), root, artifacts, maxDiffBytes },
    error: null,
    help: false,
  };
}

/**
 * Атомарная запись: временный файл в том же каталоге, затем `rename`. Прерванный прогон не
 * оставляет половину страницы на месте предыдущей.
 * @param {string} file
 * @param {string} text
 * @returns {void}
 */
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Временного файла может уже не быть — это не мешает пробросить исходную ошибку.
    }
    throw error;
  }
}

/**
 * Точка входа CLI.
 * @param {{
 *   argv?: string[],
 *   cwd?: string,
 *   log?: (line: string) => void,
 *   stderr?: (line: string) => void,
 *   writeFile?: (file: string, text: string) => void,
 * }} [deps]
 * @returns {number} код выхода
 */
export function main({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  log = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  writeFile = writeAtomic,
} = {}) {
  const parsed = parseArgs(argv, { cwd });
  if (parsed.help) {
    for (const line of USAGE.split('\n')) log(line);
    return 0;
  }
  if (parsed.error !== null || parsed.options === null) {
    stderr(`harness-viewer: ${parsed.error ?? 'неизвестная ошибка аргументов'}`);
    for (const line of USAGE.split('\n')) stderr(line);
    return 2;
  }

  const { out, artifacts, maxDiffBytes } = parsed.options;
  try {
    if (!statSync(artifacts).isDirectory()) {
      stderr(`harness-viewer: не каталог: ${artifacts}`);
      return 1;
    }
  } catch {
    stderr(`harness-viewer: каталог артефактов не найден: ${artifacts}`);
    return 1;
  }

  const tree = scanArtifacts({ artifactsDir: artifacts, maxDiffBytes });
  const html = renderPage({
    artifactsDir: artifacts,
    cycles: tree.cycles,
    problems: tree.problems,
    maxDiffBytes,
  });

  try {
    writeFile(out, html);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`harness-viewer: страница не записана: ${message}`);
    return 1;
  }

  const cycleProblems = tree.cycles.reduce((sum, cycle) => sum + cycle.problems.length, 0);
  const problems = tree.problems.length + cycleProblems;
  log(
    `harness-viewer: циклов ${tree.cycles.length}, проблем чтения ${problems} — ${out}`,
  );
  // Ошибки чтения видны на странице; прогон не считается провалившимся, пока показано, что именно
  // не прочиталось. Падать на одном битом файле значило бы скрывать остальные циклы.
  return 0;
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
