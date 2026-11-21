/**
 * Тесты правил репозитория (`tooling/repo-rules.mjs`).
 *
 * Скрипт меняет настройки живого репозитория, поэтому проверяется он без сети: исполнитель `gh`
 * подменяется, вызовы собираются в журнал. Проверяется главное свойство — правила те же, что в
 * ядре, и применяются идемпотентно: `PATCH` настроек, `PUT` защиты `main` с обязательными
 * проверками, `POST`/`PUT` ruleset тегов в зависимости от того, есть ли он уже.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MERGE_SETTINGS,
  REQUIRED_CHECKS,
  TAG_PATTERN,
  TAG_RULESET,
  main,
  parseArgs,
  protectionPayload,
  securityPatch,
  setup,
  tagRulesetPayload,
} from '../tooling/repo-rules.mjs';

/**
 * Исполнитель `gh` для тестов: пишет вызовы и отдаёт заготовленный ответ по `api <путь>`.
 * @param {Record<string, string>} answers путь → stdout
 * @returns {{ run: (args: string[], options?: { input?: string }) => string, calls: { args: string[], input?: string }[] }}
 */
function fakeGh(answers = {}) {
  /** @type {{ args: string[], input?: string }[]} */
  const calls = [];
  return {
    calls,
    run: (args, options = {}) => {
      calls.push({ args, ...(options.input === undefined ? {} : { input: options.input }) });
      if (args[0] !== 'api') return '';
      const path = args[1] === '-X' ? args[3] : args[1];
      return answers[path ?? ''] ?? '{}';
    },
  };
}

describe('payload правил', () => {
  test('режим merge — только squash, ветка удаляется', () => {
    assert.deepEqual(MERGE_SETTINGS, {
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
    });
  });

  test('защита main: PR всем, обязательные проверки, линейная история, без force-push', () => {
    const payload = protectionPayload();
    assert.deepEqual(payload.required_status_checks, {
      strict: true,
      contexts: [...REQUIRED_CHECKS],
    });
    assert.equal(payload.enforce_admins, true);
    assert.equal(payload.allow_force_pushes, false);
    assert.equal(payload.allow_deletions, false);
    assert.equal(payload.required_linear_history, true);
    assert.equal(payload.required_conversation_resolution, true);
    assert.deepEqual(payload.required_pull_request_reviews, {
      required_approving_review_count: 0,
      dismiss_stale_reviews: true,
    });
    // Имена проверок — это имена job из ci.yml: без ОС required check не появится.
    assert.deepEqual([...REQUIRED_CHECKS], ['test (ubuntu-latest)', 'test (macos-latest)']);
  });

  test('ruleset тегов запрещает удаление и перезапись', () => {
    const payload = tagRulesetPayload();
    assert.equal(payload.name, TAG_RULESET);
    assert.equal(payload.target, 'tag');
    assert.deepEqual(payload.conditions, { ref_name: { include: [TAG_PATTERN], exclude: [] } });
    assert.deepEqual(payload.rules, [{ type: 'deletion' }, { type: 'non_fast_forward' }]);
  });

  test('сканирование секретов не дублируется, если уже включено', () => {
    assert.deepEqual(
      securityPatch({ security_and_analysis: { secret_scanning_push_protection: { status: 'enabled' } } }),
      {},
    );
    assert.deepEqual(securityPatch(null), {
      security_and_analysis: {
        secret_scanning: { status: 'enabled' },
        secret_scanning_push_protection: { status: 'enabled' },
      },
    });
  });
});

describe('применение правил', () => {
  test('без --protect: только настройки репозитория', () => {
    const { run, calls } = fakeGh({
      'repos/acme/viewer': JSON.stringify({
        security_and_analysis: { secret_scanning_push_protection: { status: 'enabled' } },
      }),
    });

    const result = setup({ run, repo: 'acme/viewer' });
    assert.deepEqual(result, { merge: true, protected: false, tagRuleset: '', limitation: '' });
    // Первый вызов — чтение текущих настроек безопасности, второй — запись режима merge.
    assert.deepEqual(calls[0]?.args, ['api', 'repos/acme/viewer']);
    const patch = calls[1];
    assert.deepEqual(patch?.args, ['api', '-X', 'PATCH', 'repos/acme/viewer', '--input', '-']);
    assert.deepEqual(JSON.parse(patch?.input ?? '{}'), MERGE_SETTINGS);
    assert.equal(calls.length, 2, 'без --protect только настройки репозитория');
  });

  test('--protect: защита main и создание ruleset тегов', () => {
    const { run, calls } = fakeGh({
      'repos/acme/viewer': '{}',
      'repos/acme/viewer/rulesets': '[]',
    });

    const result = setup({ run, repo: 'acme/viewer', protect: true });
    assert.deepEqual(result, { merge: true, protected: true, tagRuleset: TAG_RULESET, limitation: '' });

    const protection = calls.find((call) => call.args.some((arg) => arg.endsWith('/protection')));
    assert.ok(protection !== undefined);
    assert.deepEqual(protection.args, [
      'api',
      '-X',
      'PUT',
      'repos/acme/viewer/branches/main/protection',
      '--input',
      '-',
    ]);
    assert.deepEqual(JSON.parse(protection.input ?? '{}').required_status_checks.contexts, [
      ...REQUIRED_CHECKS,
    ]);

    const created = calls.find((call) => call.args[3] === 'repos/acme/viewer/rulesets');
    assert.ok(created !== undefined, 'ruleset создаётся POST, если его нет');
    assert.deepEqual(created.args, ['api', '-X', 'POST', 'repos/acme/viewer/rulesets', '--input', '-']);
    assert.equal(JSON.parse(created.input ?? '{}').name, TAG_RULESET);
  });

  test('--protect: существующий ruleset обновляется, а не дублируется', () => {
    const { run, calls } = fakeGh({
      'repos/acme/viewer': '{}',
      'repos/acme/viewer/rulesets': JSON.stringify([{ id: 42, name: TAG_RULESET }]),
    });

    setup({ run, repo: 'acme/viewer', protect: true });
    const updated = calls.find((call) => call.args.includes('repos/acme/viewer/rulesets/42'));
    assert.ok(updated !== undefined);
    assert.deepEqual(updated.args, [
      'api',
      '-X',
      'PUT',
      'repos/acme/viewer/rulesets/42',
      '--input',
      '-',
    ]);
    assert.equal(
      calls.some((call) => call.args[3] === 'repos/acme/viewer/rulesets'),
      false,
      'POST не повторяется',
    );
  });

  test('--dry-run ничего не отправляет', () => {
    const { run, calls } = fakeGh();
    const lines = [];
    setup({ run, repo: 'acme/viewer', protect: true, dryRun: true, log: (line) => lines.push(line) });

    assert.equal(calls.length, 0);
    assert.ok(lines.some((line) => line.includes('(dry-run) gh api -X PUT')));
    assert.ok(lines.some((line) => line.includes('(dry-run) gh api -X POST')));
  });
});

describe('ограничения плана', () => {
  test('недоступное сканирование секретов не мешает режиму merge', () => {
    let patches = 0;
    /** @type {string[]} */
    const bodies = [];
    const run = (args, options = {}) => {
      const path = args[1] === '-X' ? args[3] : args[1];
      if (args[0] !== 'api') return '';
      if (args.includes('PATCH')) {
        patches += 1;
        bodies.push(options.input ?? '');
        if (patches === 1) {
          throw new Error('gh: Secret scanning is not available for this repository. (HTTP 422)');
        }
        return '{}';
      }
      return path === 'repos/acme/viewer' ? '{}' : '{}';
    };

    const lines = [];
    const result = setup({ run, repo: 'acme/viewer', log: (line) => lines.push(line) });
    assert.equal(patches, 2, 'второй PATCH — без настроек безопасности');
    assert.equal('security_and_analysis' in JSON.parse(bodies[1] ?? '{}'), false);
    assert.deepEqual(JSON.parse(bodies[1] ?? '{}'), MERGE_SETTINGS);
    assert.deepEqual(result, { merge: true, protected: false, tagRuleset: '', limitation: '' });
    assert.ok(lines.some((line) => line.includes('недоступны на этом плане')));
  });

  test('приватный репозиторий без Pro: merge применён, защита — нет, код 2', () => {
    const run = (args) => {
      if (args[0] !== 'api') return '';
      if (args.includes('PATCH')) return '{}';
      if (args.includes('GET') || args[1] === 'repos/acme/viewer') return '{}';
      throw new Error(
        'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)',
      );
    };
    const errors = [];
    const code = main({
      argv: ['--repo', 'acme/viewer', '--protect'],
      run,
      stderr: (line) => errors.push(line),
      log: () => {},
    });

    assert.equal(code, 2);
    assert.match(errors.join('\n'), /нужен публичный репозиторий/u);
  });
});

describe('аргументы и коды выхода', () => {
  test('parseArgs: флаги и ошибки', () => {
    assert.deepEqual(parseArgs([]), {
      protect: false,
      dryRun: false,
      repo: null,
      help: false,
      error: null,
    });
    assert.equal(parseArgs(['--protect', '--dry-run', '--repo', 'acme/viewer']).repo, 'acme/viewer');
    assert.match(parseArgs(['--protectt']).error ?? '', /неизвестный аргумент/u);
    assert.match(parseArgs(['--repo']).error ?? '', /ожидается owner\/name/u);
  });

  test('неизвестный флаг — код 2 с сообщением', () => {
    const errors = [];
    const code = main({ argv: ['--protectt'], stderr: (line) => errors.push(line), log: () => {} });
    assert.equal(code, 2);
    assert.match(errors.join('\n'), /неизвестный аргумент/u);
  });

  test('--repo передаётся в настройки без обращения к gh repo view', () => {
    const { run, calls } = fakeGh({
      'repos/acme/viewer': '{}',
      'repos/acme/viewer/rulesets': '[]',
    });
    const code = main({ argv: ['--repo', 'acme/viewer', '--protect'], run, log: () => {} });

    assert.equal(code, 0);
    assert.equal(
      calls.some((call) => call.args[0] === 'repo'),
      false,
      'имя репозитория задано явно',
    );
    assert.ok(calls.some((call) => call.args.some((arg) => arg.endsWith('/protection'))));
  });

  test('отказ по правам — код 2, прочий отказ — код 1', () => {
    const denied = () => {
      throw new Error('gh: Resource not accessible by integration (HTTP 403)');
    };
    assert.equal(main({ argv: ['--repo', 'acme/viewer'], run: denied, stderr: () => {}, log: () => {} }), 2);
    assert.equal(
      main({
        argv: ['--repo', 'acme/viewer'],
        run: () => {
          throw new Error('gh: connection reset');
        },
        stderr: () => {},
        log: () => {},
      }),
      1,
    );
  });
});
