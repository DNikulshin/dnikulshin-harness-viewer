/**
 * Тесты просмотрщика (issue #84 в `dev-harness`, ADR 0013).
 *
 * Проверяется главное обещание: страница собирается **только из файлов** и показывает состояние,
 * причину остановки и evidence по нескольким циклам; прогон не меняет дерево артефактов; битый
 * файл виден как ошибка чтения и не прячет остальные циклы; в выводе нет ни скриптов, ни внешних
 * ссылок; пакет не тянет рантайм агента и не импортирует ядро.
 *
 * Фикстура — два цикла и один каталог-мусор без `state.json`: второй нужен, чтобы проверять, что
 * просмотрщик не выдаёт посторонние каталоги за циклы.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanArtifacts } from '../src/artifacts.mjs';
import { formatBytes, escapeHtml } from '../src/format.mjs';
import { latestDecision, renderPage } from '../src/render.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'src', 'cli.mjs');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'artifacts');

/**
 * Запускает CLI.
 * @param {string[]} args
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/**
 * Копия фикстуры во временном каталоге: тесты, меняющие дерево, не портят репозиторий.
 * @param {import('node:test').TestContext} t
 * @returns {string} путь к каталогу артефактов
 */
function tempArtifacts(t) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-viewer-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const target = join(dir, 'artifacts');
  copyTree(FIXTURE, target);
  return target;
}

/**
 * Рекурсивная копия каталога.
 * @param {string} from
 * @param {string} to
 * @returns {void}
 */
function copyTree(from, to) {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) copyTree(source, target);
    else copyFileSync(source, target);
  }
}

/**
 * Снимок дерева: относительный путь → `sha256` содержимого. По нему проверяется «ничего не
 * изменено» побайтно, а не по `mtime`.
 * @param {string} dir
 * @returns {Record<string, string>}
 */
function treeHash(dir) {
  /** @type {Record<string, string>} */
  const hashes = {};
  /** @param {string} current */
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      hashes[relative(dir, path).split('\\').join('/')] = createHash('sha256')
        .update(readFileSync(path))
        .digest('hex');
    }
  };
  walk(dir);
  return hashes;
}

/**
 * Собирает страницу напрямую через API (без CLI): тестам рендера процесс не нужен.
 * @param {string} artifactsDir
 * @returns {string}
 */
function renderDirect(artifactsDir) {
  const tree = scanArtifacts({ artifactsDir });
  return renderPage({
    artifactsDir,
    cycles: tree.cycles,
    problems: tree.problems,
    maxDiffBytes: 200_000,
  });
}

describe('страница: два цикла без CLI', () => {
  test('состояние, причина остановки и evidence видны в одном файле', (t) => {
    const artifacts = tempArtifacts(t);
    const out = join(artifacts, '..', 'viewer.html');
    const result = runCli(['render', '--artifacts', artifacts, '--out', out]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /циклов 2/u);
    const html = readFileSync(out, 'utf8');

    // Оба цикла и оба решения — на одной странице.
    assert.match(html, /example-alpha/u);
    assert.match(html, /example-beta/u);
    assert.match(html, /ESCALATE/u);
    assert.match(html, /budget: 191\.47 ₽ &gt; 30 ₽/u);
    assert.match(html, /REWORK/u);
    // Причина остановки и эскалация видны без открытия JSON руками.
    assert.match(html, /эскалация/u);
    assert.match(html, /расход выше потолка/u);
    // Гейты: fail и not_run различаются.
    assert.match(html, /typecheck/u);
    assert.match(html, /not_run/u);
    assert.match(html, /no_database/u);
    // Evidence: состав и дифф.
    assert.match(html, /<code>diff\.patch<\/code>/u);
    assert.match(html, /export const answer = 42/u);
    // Отчёты агентов и манифест.
    assert.match(html, /review/u);
    assert.match(html, /evaluation/u);
    assert.match(html, /360/u);
    // Каталог без state.json/metrics.json циклом не считается.
    assert.doesNotMatch(html, /2026-11-20-scratch/u);
  });

  test('страница самодостаточна: ни скриптов, ни сети', (t) => {
    const artifacts = tempArtifacts(t);
    const html = renderDirect(artifacts);

    assert.doesNotMatch(html, /<script/iu);
    assert.doesNotMatch(html, /https?:\/\//iu);
    assert.doesNotMatch(html, /\ssrc=/iu);
    assert.match(html, /<style>/u);
  });

  test('вывод побайтно детерминирован', (t) => {
    const artifacts = tempArtifacts(t);
    assert.equal(renderDirect(artifacts), renderDirect(artifacts));
  });

  test('текст артефактов экранируется, а не исполняется как разметка', (t) => {
    const artifacts = tempArtifacts(t);
    const stateFile = join(artifacts, '2026-11-20-43-example-beta', 'state.json');
    const state = JSON.parse(readFileSync(stateFile, 'utf8'));
    state.branch = 'feat/<script>alert(1)</script>';
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

    const html = renderDirect(artifacts);
    assert.doesNotMatch(html, /<script/iu);
    assert.match(html, /&lt;script&gt;/u);
  });
});

describe('read-only: дерево артефактов не меняется', () => {
  test('побайтное сравнение до и после прогона', (t) => {
    const artifacts = tempArtifacts(t);
    const before = treeHash(artifacts);
    const out = join(dirnameOf(artifacts), 'viewer.html');

    const result = runCli(['render', '--artifacts', artifacts, '--out', out]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(treeHash(artifacts), before);
  });

  test('страница не пишется внутрь каталога артефактов без явного указания', (t) => {
    const artifacts = tempArtifacts(t);
    const result = runCli(['render', '--artifacts', artifacts]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /--out обязателен/u);
    assert.deepEqual(readdirSync(artifacts).includes('viewer.html'), false);
  });
});

describe('битые и неполные артефакты', () => {
  test('битый JSON виден как ошибка чтения, остальные циклы показаны, процесс не падает', (t) => {
    const artifacts = tempArtifacts(t);
    const beta = join(artifacts, '2026-11-20-43-example-beta');
    writeFileSync(join(beta, 'state.json'), '{ не json');
    writeFileSync(join(beta, 'gates.1.json'), '{"gates": [');
    const out = join(dirnameOf(artifacts), 'viewer.html');

    const result = runCli(['render', '--artifacts', artifacts, '--out', out]);
    assert.equal(result.code, 0, result.stderr);
    const html = readFileSync(out, 'utf8');

    assert.match(html, /Ошибка чтения/u);
    assert.match(html, /state\.json: битый JSON/u);
    assert.match(html, /gates\.1\.json: битый JSON/u);
    // Второй цикл по-прежнему на странице: один битый файл не прячет остальное.
    assert.match(html, /example-alpha/u);
  });

  test('неполный цикл: только state.json — страница собирается, пустые блоки честные', (t) => {
    const artifacts = tempArtifacts(t);
    const beta = join(artifacts, '2026-11-20-43-example-beta');
    for (const name of readdirSync(beta)) {
      if (name !== 'state.json') rmSync(join(beta, name), { recursive: true, force: true });
    }
    const out = join(dirnameOf(artifacts), 'viewer.html');

    const result = runCli(['render', '--artifacts', artifacts, '--out', out]);
    assert.equal(result.code, 0, result.stderr);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /гейтов нет/u);
    assert.match(html, /решений нет/u);
    assert.match(html, /diff\.patch нет/u);
  });
});

describe('CLI: коды и подсказки', () => {
  test('нет каталога артефактов — код 1, страница не пишется', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-viewer-empty-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const out = join(dir, 'viewer.html');

    const result = runCli(['render', '--artifacts', join(dir, 'нет-такого'), '--out', out]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /каталог артефактов не найден/u);
    assert.equal(readdirSync(dir).includes('viewer.html'), false);
  });

  test('пустой каталог артефактов — код 0 и честная страница без циклов', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-viewer-empty-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const artifacts = join(dir, 'artifacts');
    mkdirSync(artifacts);
    const out = join(dir, 'viewer.html');

    const result = runCli(['render', '--artifacts', artifacts, '--out', out]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(readFileSync(out, 'utf8'), /циклов в дереве нет/u);
  });

  test('неизвестный флаг и неизвестная команда — код 2 с подсказкой', () => {
    const unknownFlag = runCli(['render', '--out', 'x.html', '--artifact', 'y']);
    assert.equal(unknownFlag.code, 2);
    assert.match(unknownFlag.stderr, /неизвестный аргумент: --artifact/u);

    const unknownCommand = runCli(['show', '--out', 'x.html']);
    assert.equal(unknownCommand.code, 2);
    assert.match(unknownCommand.stderr, /неизвестная команда: show/u);
  });

  test('--help — код 0 и список флагов', () => {
    const result = runCli(['--help']);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /--out/u);
  });

  test('--max-diff-bytes режет большой дифф и говорит об этом', (t) => {
    const artifacts = tempArtifacts(t);
    const out = join(dirnameOf(artifacts), 'viewer.html');
    const result = runCli(['render', '--artifacts', artifacts, '--out', out, '--max-diff-bytes', '20']);
    assert.equal(result.code, 0, result.stderr);
    const html = readFileSync(out, 'utf8');
    assert.match(html, /показаны первые/u);
    assert.doesNotMatch(html, /export const answer = 42/u);
  });
});

describe('контракт пакета: нет рантайма агента и импорта ядра', () => {
  test('dependencies и peerDependencies пусты', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.deepEqual(manifest.dependencies ?? {}, {});
    assert.deepEqual(manifest.peerDependencies ?? {}, {});
    assert.deepEqual(manifest.devDependencies ?? {}, {});
  });

  test('исходники не импортируют ядро и рантайм агента', () => {
    /** @type {string[]} */
    const forbidden = [];
    for (const file of listSources(join(ROOT, 'src'))) {
      const text = readFileSync(file, 'utf8');
      for (const pattern of [
        /from\s+'@dnikulshin\/harness[^']*'/u,
        /from\s+'[^']*scripts\/lib\//u,
        /from\s+'(@firstpick|pi)[^']*'/u,
      ]) {
        if (pattern.test(text)) forbidden.push(`${relative(ROOT, file)}: ${String(pattern)}`);
      }
    }
    assert.deepEqual(forbidden, []);
  });
});

describe('чистые функции', () => {
  test('latestDecision берёт решение с наибольшей итерацией', () => {
    const cycles = scanArtifacts({ artifactsDir: FIXTURE }).cycles;
    const alpha = cycles.find((cycle) => cycle.slug === 'example-alpha');
    assert.ok(alpha !== undefined);
    assert.equal(latestDecision(alpha.decisions)?.iteration, 2);
    assert.equal(latestDecision([]), null);
    assert.equal(latestDecision(alpha.decisions)?.doc?.action, 'ESCALATE');
  });

  test('escapeHtml экранирует всё, что может стать разметкой', () => {
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });

  test('formatBytes читает байты, КБ и МБ', () => {
    assert.equal(formatBytes(512), '512 Б');
    assert.equal(formatBytes(2048), '2.0 КБ');
    assert.equal(formatBytes(5 * 1024 * 1024), '5.0 МБ');
    assert.equal(formatBytes(null), '0 Б');
  });
});

/**
 * Каталог, в котором лежит указанный путь.
 * @param {string} path
 * @returns {string}
 */
function dirnameOf(path) {
  return path.split('/').slice(0, -1).join('/') || '.';
}

/**
 * Файлы `*.mjs` под каталогом.
 * @param {string} dir
 * @returns {string[]}
 */
function listSources(dir) {
  /** @type {string[]} */
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSources(path));
      continue;
    }
    if (entry.name.endsWith('.mjs')) files.push(path);
  }
  return files;
}

// `statSync` импортирован ради проверки, что фикстура на месте: тест без неё бессмысленен.
test('фикстура с двумя циклами на месте', () => {
  assert.ok(statSync(join(FIXTURE, '2026-11-20-42-example-alpha', 'state.json')).isFile());
});
