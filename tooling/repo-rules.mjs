#!/usr/bin/env node
/**
 * Правила репозитория просмотрщика — те же, что в `dev-harness` (ядро): squash-only merge,
 * защита `main` с обязательными проверками и линейной историей, запрет удаления и перезаписи
 * релизных тегов.
 *
 * Зачем скрипт, а не ручные клики: правила процесса должны воспроизводиться одной командой.
 * Правка в UI не попадает в историю и расходится между репозиториями; тогда «PR обязателен»
 * верно в одном месте и неверно в другом, и это выясняется на первом прямом push.
 *
 * ```
 * node tooling/repo-rules.mjs              режим merge (squash-only) и сканирование секретов
 * node tooling/repo-rules.mjs --protect    ещё защита main и правила тегов
 * node tooling/repo-rules.mjs --dry-run    показать вызовы gh, ничего не менять
 * ```
 *
 * Переменные: `REPO` (по умолчанию — текущий репозиторий, `gh repo view`).
 *
 * Коды выхода: `0` — настроено; `2` — ошибка параметров или отказ `gh` на уровне прав
 * (нет admin, приватный репозиторий на бесплатном плане); `1` — прочий отказ.
 *
 * Shebang нужен: скрипт запускается напрямую.
 */
import { execFileSync } from 'node:child_process';

import { isDirectRun } from '../src/direct-run.mjs';

/** Режим merge: только squash, ветка после мержа удаляется. */
export const MERGE_SETTINGS = Object.freeze({
  allow_squash_merge: true,
  allow_merge_commit: false,
  allow_rebase_merge: false,
  delete_branch_on_merge: true,
});

/**
 * Обязательные проверки `main` — имена job из `.github/workflows/ci.yml` (матрица `test` по
 * `ubuntu-latest` и `macos-latest`, как `os` в `package.json`). Имена включают ОС: при смене
 * матрицы их нужно менять вместе с ней, иначе required check не появится и merge встанет.
 * @type {readonly string[]}
 */
export const REQUIRED_CHECKS = Object.freeze(['test (ubuntu-latest)', 'test (macos-latest)']);

/** Имя ruleset защиты релизных тегов. */
export const TAG_RULESET = 'release-tags';

/** Шаблон тегов релиза: по нему потребитель ставит пакет (`#vX.Y.Z`). */
export const TAG_PATTERN = 'refs/tags/v*';

/** Ошибка настройки: в CLI превращается в код 2 (параметры, права). */
export class SetupError extends Error {}

/**
 * Исполнитель `gh`: аргументы и stdin → stdout. В тестах подменяется.
 * @typedef {(args: string[], options?: { input?: string }) => string} RunGh
 */

/**
 * Тело правил ветки `main` (REST `PUT /branches/main/protection`).
 * @param {readonly string[]} [checks]
 * @returns {Record<string, unknown>}
 */
export function protectionPayload(checks = REQUIRED_CHECKS) {
  return {
    required_status_checks: { strict: true, contexts: [...checks] },
    enforce_admins: true,
    required_pull_request_reviews: {
      required_approving_review_count: 0,
      dismiss_stale_reviews: true,
    },
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
    // Squash-only — настройка репозитория, линейная история — гейт: merge-коммит, появившийся в
    // обход настроек (UI, API), не пройдёт.
    required_linear_history: true,
    required_conversation_resolution: true,
  };
}

/**
 * Ruleset защиты тегов релиза: тег нельзя удалить или перезаписать. Тег — контракт для
 * потребителя (`#vX.Y.Z` в `dependencies`), перезапись делает установку невоспроизводимой.
 * @returns {Record<string, unknown>}
 */
export function tagRulesetPayload() {
  return {
    name: TAG_RULESET,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: [TAG_PATTERN], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
  };
}

/**
 * Что включить в настройках безопасности: сканирование секретов и блокировку push с секретом.
 * Уже включённое не дублируется — повторный PATCH на включённой настройке отвечает 422.
 * @param {unknown} repo документ `GET /repos/{repo}` (или `null`, если не прочитался)
 * @returns {Record<string, unknown>} часть тела PATCH (пусто, если включать нечего)
 */
export function securityPatch(repo) {
  const status = /** @type {any} */ (repo)?.security_and_analysis?.secret_scanning_push_protection
    ?.status;
  if (status === 'enabled') return {};
  return {
    security_and_analysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    },
  };
}

/**
 * Применяет правила. Идемпотентно: те же значения перезаписываются теми же значениями.
 * @param {{
 *   run: RunGh,
 *   repo: string,
 *   protect?: boolean,
 *   dryRun?: boolean,
 *   log?: (line: string) => void,
 * }} params
 * @returns {{ merge: boolean, protected: boolean, tagRuleset: string }}
 */
export function setup({ run, repo, protect = false, dryRun = false, log = () => {} }) {
  /** @type {RunGh} */
  const exec = dryRun
    ? (args, options = {}) => {
        const stdin = options.input === undefined ? '' : ' (+ stdin)';
        log(`(dry-run) gh ${args.join(' ')}${stdin}`);
        return '{}';
      }
    : run;

  /** @type {Record<string, unknown>} */
  const repoPatch = { ...MERGE_SETTINGS };
  if (dryRun) {
    Object.assign(repoPatch, securityPatch(null));
  } else {
    /** @type {unknown} */
    let current = null;
    try {
      current = JSON.parse(run(['api', `repos/${repo}`]));
    } catch {
      // Не читается — включаем явно: лишний PATCH безопаснее выключенной проверки.
      current = null;
    }
    Object.assign(repoPatch, securityPatch(current));
  }
  exec(['api', '-X', 'PATCH', `repos/${repo}`, '--input', '-'], {
    input: JSON.stringify(repoPatch),
  });
  log(
    'merge: только squash, ветка удаляется после мержа; ' +
      `секреты: ${repoPatch.security_and_analysis === undefined ? 'уже включены' : 'сканирование и блокировка push включены'}`,
  );

  let protectedBranch = false;
  let tagRuleset = '';
  if (protect) {
    exec(['api', '-X', 'PUT', `repos/${repo}/branches/main/protection`, '--input', '-'], {
      input: JSON.stringify(protectionPayload()),
    });
    protectedBranch = true;
    log(
      `main: PR обязателен всем, обязательны проверки ${REQUIRED_CHECKS.join(', ')}, ` +
        'линейная история, комментарии должны быть закрыты',
    );

    // Ruleset тегов: ищем по имени — есть, обновляем (PUT), нет, создаём (POST).
    /** @type {any[]} */
    let rulesets = [];
    if (!dryRun) {
      try {
        const listed = JSON.parse(run(['api', `repos/${repo}/rulesets`]));
        rulesets = Array.isArray(listed) ? listed : [];
      } catch {
        rulesets = [];
      }
    }
    const existing = rulesets.find((item) => item?.name === TAG_RULESET);
    const rulesetPath = existing ? `repos/${repo}/rulesets/${existing.id}` : `repos/${repo}/rulesets`;
    exec(['api', '-X', existing === undefined ? 'POST' : 'PUT', rulesetPath, '--input', '-'], {
      input: JSON.stringify(tagRulesetPayload()),
    });
    tagRuleset = TAG_RULESET;
    log(`теги: ${TAG_PATTERN} нельзя удалить или перезаписать (ruleset ${TAG_RULESET})`);
  }

  return { merge: true, protected: protectedBranch, tagRuleset };
}

/**
 * Разбор аргументов: неизвестный флаг — ошибка, а не игнор.
 * @param {string[]} argv
 * @returns {{ protect: boolean, dryRun: boolean, repo: string|null, help: boolean, error: string|null }}
 */
export function parseArgs(argv) {
  /** @type {{ protect: boolean, dryRun: boolean, repo: string|null, help: boolean, error: string|null }} */
  const options = { protect: false, dryRun: false, repo: null, help: false, error: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--protect') options.protect = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--repo') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        return { ...options, error: '--repo: ожидается owner/name' };
      }
      options.repo = value;
      index += 1;
    } else return { ...options, error: `неизвестный аргумент: ${arg}` };
  }
  return options;
}

/** Исполнитель `gh` по умолчанию. */
const ghRun = (/** @type {string[]} */ args, /** @type {{input?: string}} */ options = {}) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...(options.input === undefined ? {} : { input: options.input }),
  });

/**
 * @param {string} message
 * @returns {string}
 */
function firstLine(message) {
  return message.split('\n')[0] ?? '';
}

/**
 * Точка входа CLI.
 * @param {{
 *   argv?: string[],
 *   run?: RunGh,
 *   log?: (line: string) => void,
 *   stderr?: (line: string) => void,
 * }} [deps]
 * @returns {number} код выхода
 */
export function main({ argv = process.argv.slice(2), run = ghRun, log = console.log, stderr = console.error } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    log('node tooling/repo-rules.mjs [--protect] [--dry-run] [--repo owner/name]');
    return 0;
  }
  if (options.error !== null) {
    stderr(`repo-rules: ${options.error}`);
    return 2;
  }

  let repo = options.repo;
  try {
    if (repo === null) {
      const fromEnv = process.env.REPO;
      repo =
        typeof fromEnv === 'string' && fromEnv.trim() !== ''
          ? fromEnv.trim()
          : String(JSON.parse(run(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner ?? '');
    }
  } catch (error) {
    stderr(`repo-rules: репозиторий не определён: ${firstLine(error instanceof Error ? error.message : String(error))}`);
    return 1;
  }
  if (repo === null || repo === '') {
    stderr('repo-rules: репозиторий не определён — задайте REPO=owner/name или --repo');
    return 1;
  }

  try {
    setup({
      run,
      repo,
      protect: options.protect,
      dryRun: options.dryRun,
      log,
    });
    log(`repo-rules: ${repo} настроен${options.protect ? ' с защитой main' : ''}`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`repo-rules: ${firstLine(message)}`);
    // Права и план — отдельный код: «нет admin» и «упало что-то» лечатся по-разному.
    if (/admin|403|404|forbidden|not found/iu.test(message)) return 2;
    return 1;
  }
}

// Модуль импортируется тестами ради чистых функций; CLI запускается только напрямую.
if (isDirectRun(import.meta.url)) {
  process.exitCode = main();
}
