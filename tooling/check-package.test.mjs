/**
 * Тесты контракта архива и релизной проверки (issue #3).
 *
 * Проверка, которая не краснеет на сломанном архиве, ничего не доказывает: `release.yml` запускает
 * её как гейт, и если правила терпимы к пропущенному `src/cli.mjs` или к расхождению тега с
 * `package.json`, публикация пройдёт — а версию в npm перезаписать нельзя. Поэтому находки
 * проверяются здесь, на синтетических списках файлов, и один раз — на настоящем `npm pack`.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { archiveEntries, checkArchive, parseArgs } from './check-package.mjs';
import {
  PACKAGE_NAME,
  REQUIRED_ENTRIES,
  archiveProblems,
  coveredByFiles,
  filesProblems,
  packageProblems,
  promisedPaths,
} from './package-contract.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(ROOT, 'tooling', 'check-package.mjs');
const PACKAGE_FILE = join(ROOT, 'package.json');
const VERSION = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8')).version;

/** Полный архив: все обязательные записи контракта. */
const FULL = Object.freeze([...REQUIRED_ENTRIES]);

/**
 * Минимальный разобранный `package.json` для проверки обещаний.
 * @param {{ bin?: unknown, exports?: unknown, private?: unknown, version?: string, name?: string }} [overrides]
 * @returns {Record<string, any>}
 */
function pkg(overrides = {}) {
  return {
    name: PACKAGE_NAME,
    version: '0.1.0',
    private: false,
    bin: { 'harness-viewer': './src/cli.mjs' },
    ...overrides,
  };
}

/**
 * Запускает CLI проверки архива.
 * @param {string[]} args
 * @returns {{ code: number, stdout: string, stderr: string }}
 */
function runCheck(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

describe('контракт архива', () => {
  test('полный архив — находок нет', () => {
    assert.deepEqual(archiveProblems(FULL), []);
  });

  test('пропущенная обязательная запись — находка с именем файла', () => {
    const problems = archiveProblems(FULL.filter((path) => path !== 'src/cli.mjs'));

    assert.equal(problems.length, 1);
    assert.match(problems.join('\n'), /нет src\/cli\.mjs/u);
  });

  test('тесты и инфраструктура в архиве — находки с префиксами', () => {
    const problems = archiveProblems([
      ...FULL,
      'test/viewer.test.mjs',
      'test/fixtures/artifacts/2026-11-20-42-example-alpha/state.json',
      'tooling/check-package.mjs',
      '.github/workflows/ci.yml',
    ]);

    assert.equal(problems.length, 3);
    assert.ok(problems.some((problem) => problem.includes('test/')));
    assert.ok(problems.some((problem) => problem.includes('tooling/')));
    assert.ok(problems.some((problem) => problem.includes('.github/')));
  });
});

describe('files покрывает контракт', () => {
  test('текущий package.json покрывает все обязательные записи', () => {
    const pkgJson = JSON.parse(readFileSync(PACKAGE_FILE, 'utf8'));

    assert.deepEqual(filesProblems(pkgJson), []);
  });

  test('суженный files — находка на каждый непокрытый путь', () => {
    const problems = filesProblems(pkg({ files: ['README.md', 'LICENSE'] }));

    assert.ok(problems.some((problem) => problem.includes('src/cli.mjs')));
    // package.json, README.md и LICENSE npm включает всегда: их покрытие не требуется.
    assert.ok(!problems.some((problem) => problem.includes('README.md')));
  });

  test('coveredByFiles: каталог с завершающим слэшем покрывает содержимое', () => {
    assert.equal(coveredByFiles('src/cli.mjs', ['src/']), true);
    assert.equal(coveredByFiles('src/cli.mjs', ['src']), false);
    assert.equal(coveredByFiles('package.json', []), true);
  });
});

describe('обещания package.json', () => {
  test('promisedPaths собирает bin и exports без шаблонных ключей', () => {
    assert.deepEqual(
      promisedPaths(
        pkg({
          bin: { 'harness-viewer': './src/cli.mjs', extra: './src/render.mjs' },
          exports: {
            './fixtures/*': './fixtures/*',
            '.': { types: './types.d.mts', default: './src/cli.mjs' },
          },
        }),
      ),
      ['src/cli.mjs', 'src/render.mjs', 'types.d.mts'],
    );
  });

  test('расхождение версии с тегом — находка', () => {
    const problems = packageProblems({
      pkg: pkg({ version: '0.1.0' }),
      entries: FULL,
      expected: { version: '0.2.0' },
    });

    assert.equal(problems.length, 1);
    assert.match(problems.join('\n'), /в архиве версия 0\.1\.0, ожидалось 0\.2\.0/u);
  });

  test('расхождение имени пакета — находка', () => {
    const problems = packageProblems({
      pkg: pkg({ name: 'other-package' }),
      entries: FULL,
      expected: { name: PACKAGE_NAME },
    });

    assert.match(problems.join('\n'), /в архиве имя other-package/u);
  });

  test('пропавший файл bin, отсутствие bin и private: true — находки', () => {
    const missing = packageProblems({
      pkg: pkg({ bin: { 'harness-viewer': './src/nope.mjs' } }),
      entries: FULL,
    });
    assert.match(missing.join('\n'), /обещает src\/nope\.mjs/u);

    const none = packageProblems({ pkg: pkg({ bin: undefined }), entries: FULL });
    assert.match(none.join('\n'), /без bin/u);

    const hidden = packageProblems({ pkg: pkg({ private: true }), entries: FULL });
    assert.match(hidden.join('\n'), /private: true/u);
  });
});

describe('настоящий архив npm pack', () => {
  /** @type {string} */
  let dir;
  /** @type {string} */
  let archive;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-viewer-pack-'));
    const packed = spawnSync('npm', ['pack', '--pack-destination', dir], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(packed.status, 0, `npm pack упал: ${packed.stderr}`);
    archive = join(dir, packed.stdout.trim().split('\n').at(-1) ?? '');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('состав: точка входа и лицензия есть, тестов и tooling нет', () => {
    const entries = archiveEntries(archive);

    assert.ok(entries.includes('src/cli.mjs'));
    assert.ok(entries.includes('LICENSE'), 'LICENSE обязан быть в архиве: лицензия — часть пакета');
    assert.deepEqual(
      entries.filter((entry) => entry.startsWith('test/') || entry.startsWith('tooling/')),
      [],
    );
  });

  test('архив проходит проверку с тегом своей версии', () => {
    assert.deepEqual(checkArchive({ file: archive, tag: `v${VERSION}`, packageFile: PACKAGE_FILE }), []);
  });

  test('CLI: совпадающий тег — код 0, расходящийся — код 1 с находкой', () => {
    const ok = runCheck([archive, '--tag', `v${VERSION}`, '--package', PACKAGE_FILE]);
    assert.equal(ok.code, 0, ok.stderr);

    const wrong = runCheck([archive, '--tag', 'v9.9.9']);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /тег и package.json расходятся/u);
  });
});

describe('разбор аргументов и коды ошибок', () => {
  test('parseArgs: архив обязателен, --tag и --package отдельными флагами', () => {
    const parsed = parseArgs(['pack.tgz', '--tag', 'v0.1.0', '--package', 'package.json']);
    assert.equal(parsed.tag, 'v0.1.0');
    assert.equal(parsed.packageFile, join(process.cwd(), 'package.json'));
    assert.equal(parseArgs(['pack.tgz']).tag, null);
    assert.throws(() => parseArgs([]), /использование: check-package/u);
    assert.throws(() => parseArgs(['a.tgz', '--tag']), /--tag: ожидается vX\.Y\.Z/u);
    assert.throws(() => parseArgs(['a.tgz', 'b.tgz']), /лишний аргумент/u);
    assert.throws(() => parseArgs(['a.tgz', '--nope']), /неизвестный аргумент/u);
  });

  test('несуществующий архив — ошибка, а не пустой список находок', (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-viewer-check-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    assert.throws(() => checkArchive({ file: join(dir, 'нет.tgz') }), /архив не найден/u);
  });

  test('CLI: без аргументов — код 2, нечитаемый архив — код 2', (t) => {
    assert.equal(runCheck([]).code, 2);

    const dir = mkdtempSync(join(tmpdir(), 'harness-viewer-check-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const empty = join(dir, 'empty.tgz');
    writeFileSync(empty, '');

    const result = runCheck([empty]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /check-package:/u);
  });
});
