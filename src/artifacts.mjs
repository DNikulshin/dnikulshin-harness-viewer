/**
 * Чтение дерева артефактов цикла (ADR 0013 в `dev-harness`).
 *
 * Контракт — файлы, а не код: просмотрщик разбирает `state.json`, `gates.<n>.json`,
 * `decision.<n>.json`, `escalation.json`, `metrics.json`, `manifest.<n>.json` и `evidence/` по
 * именам и полям Приложения A `docs/orchestrator-core.md`. Импорт ядра запрещён, поэтому разбор
 * свой — и он **терпимый**: битый или неполный файл становится ошибкой чтения рядом с блоком,
 * а не падением процесса и не догадкой. Просмотрщик ничего не пишет: только `readFileSync` и
 * `readdirSync`.
 *
 * Значения полей не пересчитываются: вердикты и причины берутся из решений ядра как есть. Если
 * поля нет — в выводе не ноль и не «нет проблем», а честное «нет данных».
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Сколько байт диффа показывать по умолчанию: файл бывает большим, а страница — одна. */
export const DEFAULT_MAX_DIFF_BYTES = 200_000;

/** Предел размера любого другого файла, который читается в память. */
const MAX_TEXT_BYTES = 5_000_000;

/**
 * @typedef {object} ReadResult
 * @property {Record<string, any>|null} doc разобранный JSON или `null`
 * @property {string|null} error ошибка чтения одной строкой
 */

/**
 * Файл → `{ doc, error }`. Отсутствие файла — не ошибка, а «нет данных»: у неполного цикла
 * половины артефактов штатно нет.
 * @param {string} file
 * @returns {ReadResult}
 */
export function readJsonFile(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return { doc: null, error: null };
    return { doc: null, error: `не читается: ${firstLine(error)}` };
  }

  try {
    const raw = JSON.parse(text);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { doc: null, error: 'ожидается JSON-объект' };
    }
    return { doc: raw, error: null };
  } catch (error) {
    return { doc: null, error: `битый JSON: ${firstLine(error)}` };
  }
}

/**
 * Текст файла с потолком размера. Отсутствие — `null` без ошибки.
 * @param {string} file
 * @param {number} limit
 * @returns {{ text: string|null, totalBytes: number, truncated: boolean, error: string|null }}
 */
export function readTextFile(file, limit) {
  let bytes;
  try {
    bytes = statSync(file).size;
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    return {
      text: null,
      totalBytes: 0,
      truncated: false,
      error: code === 'ENOENT' ? null : `не читается: ${firstLine(error)}`,
    };
  }

  if (bytes > MAX_TEXT_BYTES) {
    return { text: null, totalBytes: bytes, truncated: true, error: 'файл слишком большой' };
  }

  try {
    const text = readFileSync(file, 'utf8');
    const cut = text.length > limit ? text.slice(0, limit) : text;
    return { text: cut, totalBytes: bytes, truncated: text.length > limit, error: null };
  } catch (error) {
    return { text: null, totalBytes: bytes, truncated: false, error: firstLine(error) };
  }
}

/**
 * Ошибка одной строкой: в таблицу проблем многострочный стек не помещается.
 * @param {unknown} error
 * @returns {string}
 */
function firstLine(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? '';
}

/**
 * Файлы каталога рекурсивно: относительные posix-пути и размеры, отсортированные по пути.
 * Незавершённый симлинк и нечитаемый файл — строка проблемы, а не исключение.
 * @param {string} dir
 * @returns {{ files: { path: string, bytes: number }[], problems: string[] }}
 */
export function listFiles(dir) {
  /** @type {{ path: string, bytes: number }[]} */
  const files = [];
  /** @type {string[]} */
  const problems = [];

  /** @param {string} current */
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      problems.push(`${relative(dir, current) || '.'}: не читается (${firstLine(error)})`);
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      try {
        files.push({ path: relative(dir, path).split('\\').join('/'), bytes: statSync(path).size });
      } catch (error) {
        problems.push(`${relative(dir, path)}: не читается (${firstLine(error)})`);
      }
    }
  };

  walk(dir);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, problems };
}

/**
 * Номера итераций, для которых есть файл указанного вида (`gates.<n>.json`).
 * @param {string[]} names
 * @param {string} prefix
 * @param {string} suffix
 * @returns {number[]}
 */
export function iterationsOf(names, prefix, suffix) {
  const pattern = new RegExp(`^${prefix}\\.(\\d+)${suffix.replace('.', '\\.')}$`, 'u');
  /** @type {number[]} */
  const numbers = [];
  for (const name of names) {
    const match = pattern.exec(name);
    if (match === null) continue;
    const iteration = Number(match[1]);
    if (Number.isInteger(iteration) && iteration > 0 && !numbers.includes(iteration)) {
      numbers.push(iteration);
    }
  }
  return numbers.sort((left, right) => left - right);
}

/**
 * Один цикл со всеми артефактами, которые нашлись. Ничего не выбрасывает: непрочитанный файл
 * остаётся в выводе строкой проблемы.
 * @param {string} dir каталог цикла
 * @param {{ maxDiffBytes?: number }} [options]
 * @returns {Record<string, any>}
 */
export function readCycle(dir, { maxDiffBytes = DEFAULT_MAX_DIFF_BYTES } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (error) {
    return {
      slug: dir.split('/').at(-1) ?? dir,
      dir,
      problems: [`каталог не читается: ${firstLine(error)}`],
      state: { doc: null, error: 'каталог не читается' },
      escalation: { doc: null, error: null },
      metrics: { doc: null, error: null },
      gates: [],
      decisions: [],
      manifests: [],
      reports: [],
      evidence: { files: [], problems: [] },
      diff: { text: null, totalBytes: 0, truncated: false, error: null },
    };
  }

  /** @type {string[]} */
  const problems = [];
  const state = readJsonFile(join(dir, 'state.json'));
  if (state.error !== null) problems.push(`state.json: ${state.error}`);

  const slug =
    typeof state.doc?.slug === 'string' && state.doc.slug !== ''
      ? state.doc.slug
      : (dir.split('/').at(-1) ?? dir);

  /** @param {ReadResult} result @param {string} label */
  const collect = (result, label) => {
    if (result.error !== null) problems.push(`${label}: ${result.error}`);
    return result;
  };

  const gates = iterationsOf(names, 'gates', '.json').map((iteration) => ({
    iteration,
    ...collect(readJsonFile(join(dir, `gates.${iteration}.json`)), `gates.${iteration}.json`),
  }));
  const decisions = iterationsOf(names, 'decision', '.json').map((iteration) => ({
    iteration,
    ...collect(readJsonFile(join(dir, `decision.${iteration}.json`)), `decision.${iteration}.json`),
  }));
  const manifests = iterationsOf(names, 'manifest', '.json').map((iteration) => ({
    iteration,
    ...collect(readJsonFile(join(dir, `manifest.${iteration}.json`)), `manifest.${iteration}.json`),
  }));

  const evidenceDir = join(dir, 'evidence');
  const evidence = listFiles(evidenceDir);
  problems.push(...evidence.problems.map((line) => `evidence/${line}`));

  const diff = readTextFile(join(evidenceDir, 'diff.patch'), maxDiffBytes);
  if (diff.error !== null) problems.push(`evidence/diff.patch: ${diff.error}`);

  /** Отчёты агентов показываются как факт «есть/нет и сколько весит»: разбирать markdown — работа
   * ядра, а не просмотрщика. */
  const reports = ['review', 'evaluation']
    .flatMap((kind) =>
      iterationsOf(names, kind, '.md').map((iteration) => {
        const file = join(dir, `${kind}.${iteration}.md`);
        const text = readTextFile(file, 0);
        if (text.error !== null) problems.push(`${kind}.${iteration}.md: ${text.error}`);
        return { kind, iteration, bytes: text.totalBytes, present: text.text !== null };
      }),
    )
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.iteration - right.iteration);

  return {
    slug,
    dir,
    problems,
    state,
    escalation: collect(readJsonFile(join(dir, 'escalation.json')), 'escalation.json'),
    metrics: collect(readJsonFile(join(dir, 'metrics.json')), 'metrics.json'),
    gates,
    decisions,
    manifests,
    reports,
    evidence: { files: evidence.files },
    diff,
  };
}

/**
 * Дерево артефактов целиком: каталоги циклов по возрастанию имени. Каталог без `state.json` и
 * `metrics.json` циклом не считается — это не артефакты, а мусор рядом с ними.
 * @param {{ artifactsDir: string, maxDiffBytes?: number }} input
 * @returns {{ artifactsDir: string, cycles: Record<string, any>[], problems: string[] }}
 */
export function scanArtifacts({ artifactsDir, maxDiffBytes = DEFAULT_MAX_DIFF_BYTES }) {
  /** @type {string[]} */
  const problems = [];
  let entries;
  try {
    entries = readdirSync(artifactsDir, { withFileTypes: true });
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String(error.code) : '';
    const message = code === 'ENOENT' ? 'каталог артефактов не найден' : firstLine(error);
    return { artifactsDir, cycles: [], problems: [`${artifactsDir}: ${message}`] };
  }

  /** @type {Record<string, any>[]} */
  const cycles = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(artifactsDir, entry.name);
    let hasCycleFile = false;
    try {
      hasCycleFile = readdirSync(dir).some((name) => name === 'state.json' || name === 'metrics.json');
    } catch (error) {
      problems.push(`${entry.name}: не читается (${firstLine(error)})`);
      continue;
    }
    if (!hasCycleFile) continue;
    cycles.push(readCycle(dir, { maxDiffBytes }));
  }
  return { artifactsDir, cycles, problems };
}
