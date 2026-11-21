/**
 * Рендер страницы просмотрщика (ADR 0006/0013 в `dev-harness`).
 *
 * Правила жёсткие и проверяемые:
 *
 * - страница **самодостаточна**: стили внутри, ни одного `<script>`, ни одной внешней ссылки —
 *   открывается двойным щелчком, с телефона и без сети;
 * - вывод **побайтно детерминирован**: ни времени сборки, ни абсолютных путей, всё отсортировано;
 * - просмотрщик **показывает, а не решает**: значения берутся из файлов ядра как есть, ничего не
 *   пересчитывается; нет данных — так и написано, а не ноль и не «всё хорошо».
 */
import { escapeHtml, formatBytes } from './format.mjs';

/**
 * @param {string} tag
 * @param {Record<string, string>} [attributes]
 * @param {string} content
 * @returns {string}
 */
function element(tag, attributes, content) {
  const attrs = Object.entries(attributes ?? {})
    .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
    .join('');
  return `<${tag}${attrs}>${content}</${tag}>`;
}

/**
 * Таблица «всегда с заголовком, даже пустая»: пустая таблица с шапкой честнее выпавшего блока.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
function table(headers, rows) {
  const head = element(
    'tr',
    {},
    headers.map((header) => element('th', {}, escapeHtml(header))).join(''),
  );
  const body = rows
    .map((row) =>
      element('tr', {}, row.map((cell) => element('td', {}, cell)).join('')),
    )
    .join('');
  return element('table', {}, element('thead', {}, head) + element('tbody', {}, body));
}

/**
 * Значение поля как текст с явным «нет данных» вместо пустоты.
 * @param {unknown} value
 * @returns {string}
 */
function value(value) {
  if (value === null || value === undefined) return '<span class="muted">нет данных</span>';
  if (typeof value === 'boolean') return value ? 'да' : 'нет';
  if (typeof value === 'number') return escapeHtml(String(value));
  if (typeof value === 'string') return value === '' ? '<span class="muted">пусто</span>' : escapeHtml(value);
  return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
}

/**
 * Список строк как `<ul>`; пустой список — «нет данных».
 * @param {unknown[]|null|undefined} items
 * @returns {string}
 */
function list(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<p class="muted">нет данных</p>';
  }
  return element(
    'ul',
    {},
    items.map((item) => element('li', {}, value(item))).join(''),
  );
}

/**
 * Пара «поле — значение» в списке фактов.
 * @param {string} label
 * @param {string} rendered
 * @returns {string}
 */
function fact(label, rendered) {
  return `<dt>${escapeHtml(label)}</dt><dd>${rendered}</dd>`;
}

/**
 * Блок проблем чтения: ошибка показывается рядом с местом, где данных не хватило.
 * @param {string[]} problems
 * @returns {string}
 */
function problemsBlock(problems) {
  if (problems.length === 0) return '';
  return `<div class="problem">${element(
    'p',
    {},
    escapeHtml('Ошибка чтения — данные показаны как есть, без догадок:'),
  )}${list(problems)}</div>`;
}

/**
 * Последнее решение цикла: по нему и видна причина остановки.
 * @param {{ iteration: number, doc: Record<string, any>|null }[]} decisions
 * @returns {{ iteration: number, doc: Record<string, any>|null }|null}
 */
export function latestDecision(decisions) {
  if (decisions.length === 0) return null;
  return decisions.reduce((latest, item) => (item.iteration > latest.iteration ? item : latest));
}

/**
 * Причина остановки цикла: `action` и `reasons[]` последнего решения, плюс эскалация из
 * `state.json` и `escalation.json`, если она есть.
 * @param {Record<string, any>} cycle
 * @returns {string}
 */
export function stopReason(cycle) {
  const latest = latestDecision(cycle.decisions);
  /** @type {string[]} */
  const parts = [];

  if (latest === null) {
    parts.push('<p class="muted">решений нет: цикл не дошёл до DECIDE</p>');
  } else if (latest.doc === null) {
    parts.push('<p class="muted">решение не прочитано</p>');
  } else {
    parts.push(
      `<p>решение итерации ${escapeHtml(String(latest.iteration))}: <strong>${value(
        latest.doc.action,
      )}</strong></p>`,
    );
    parts.push(list(latest.doc.reasons));
    const counts = latest.doc.counts;
    if (counts !== null && typeof counts === 'object') {
      parts.push(
        `<p class="muted">счётчики: ${escapeHtml(
          Object.entries(counts)
            .map(([key, number]) => `${key}=${String(number)}`)
            .join(', '),
        )}</p>`,
      );
    }
  }

  const escalation = cycle.escalation?.doc;
  if (escalation !== null && typeof escalation === 'object') {
    parts.push(
      `<p>эскалация: <strong>${value(escalation.reason)}</strong> — ${value(escalation.detail)}</p>`,
    );
  }
  const stateEscalation = cycle.state?.doc?.escalation;
  if (stateEscalation !== null && typeof stateEscalation === 'object') {
    parts.push(
      `<p>эскалация в состоянии: <strong>${value(stateEscalation.reason)}</strong> — ${value(
        stateEscalation.detail,
      )}</p>`,
    );
  }
  return parts.join('');
}

/**
 * Факты одного цикла: где он, в какой стадии и чем закончился.
 * @param {Record<string, any>} cycle
 * @returns {string}
 */
function cycleFacts(cycle) {
  const state = cycle.state?.doc ?? {};
  const metrics = cycle.metrics?.doc ?? {};
  const context = metrics.context ?? null;

  const facts = [
    fact('каталог', value(cycle.dir)),
    fact('ветка', value(state.branch)),
    fact('стадия', `${value(state.stage)} / ${value(state.stage_status)}`),
    fact('итерация', `${value(state.iteration)} из ${value(state.max_iterations)}`),
    fact('подтверждение владельца', value(state.owner_approved)),
    fact('начат', value(state.started_at)),
    fact('обновлён', value(state.updated_at)),
    fact('стоимость', value(metrics.cost_rub)),
    fact('длительность цикла, с', value(metrics.cycle_duration_s)),
    fact('гейты, с', value(metrics.gate_total_s)),
  ];
  if (context !== null && typeof context === 'object') {
    facts.push(fact('evidence, байт', value(context.evidence_bytes)));
    facts.push(fact('доля кэша', value(context.cache_share)));
  }
  return `<dl class="facts">${facts.join('')}</dl>`;
}

/**
 * Гейты всех итераций одним блоком: `not_run` и `fail` — разные факты, поэтому статус печатается
 * как есть, без агрегата.
 * @param {Record<string, any>} cycle
 * @returns {string}
 */
function gatesBlock(cycle) {
  if (cycle.gates.length === 0) return '<p class="muted">гейтов нет</p>';
  return cycle.gates
    .map((item) => {
      if (item.doc === null) {
        return `<h4>гейты, итерация ${escapeHtml(String(item.iteration))}</h4><p class="muted">файл не прочитан</p>`;
      }
      const rows = (Array.isArray(item.doc.gates) ? item.doc.gates : []).map((gate) => [
        value(gate?.id),
        value(gate?.status),
        gate?.required === true ? 'да' : 'нет',
        value(gate?.exit),
        value(gate?.duration_s),
        value(gate?.reason),
      ]);
      return `<h4>гейты, итерация ${escapeHtml(String(item.iteration))}</h4>${table(
        ['гейт', 'статус', 'обязательный', 'код', 'секунды', 'причина'],
        rows,
      )}`;
    })
    .join('');
}

/**
 * Решения всех итераций: последнее разобрано в «причине остановки», остальные — строкой.
 * @param {Record<string, any>} cycle
 * @returns {string}
 */
function decisionsBlock(cycle) {
  if (cycle.decisions.length === 0) return '<p class="muted">решений нет</p>';
  const rows = cycle.decisions.map((item) => [
    escapeHtml(String(item.iteration)),
    item.doc === null ? '<span class="muted">не прочитано</span>' : value(item.doc.action),
    item.doc === null ? '' : value(item.doc.unverified?.length ?? 0),
    item.doc === null ? '' : value(item.doc.rework_items?.length ?? 0),
  ]);
  return table(['итерация', 'действие', 'не проверено', 'доработок'], rows);
}

/**
 * Пакет `evidence/`: состав с размерами и дифф целиком (с потолком).
 * @param {Record<string, any>} cycle
 * @param {{ maxDiffBytes: number }} options
 * @returns {string}
 */
function evidenceBlock(cycle, options) {
  const rows = cycle.evidence.files.map((file) => [
    `<code>${escapeHtml(file.path)}</code>`,
    value(file.bytes),
  ]);
  const parts = [table(['файл', 'байт'], rows)];

  const diff = cycle.diff;
  if (diff.text === null) {
    parts.push('<p class="muted">diff.patch нет</p>');
  } else {
    const note = diff.truncated
      ? `<p class="muted">показаны первые ${formatBytes(options.maxDiffBytes)} из ${formatBytes(
          diff.totalBytes,
        )}</p>`
      : `<p class="muted">diff.patch, ${formatBytes(diff.totalBytes)}</p>`;
    parts.push(
      `<details><summary>дифф</summary>${note}${element(
        'pre',
        {},
        escapeHtml(diff.text),
      )}</details>`,
    );
  }
  return parts.join('');
}

/**
 * Манифесты (ADR 0009): размер пакета по итерациям — факт, а не оценка.
 * @param {Record<string, any>} cycle
 * @returns {string}
 */
function manifestsBlock(cycle) {
  if (cycle.manifests.length === 0) return '<p class="muted">манифестов нет</p>';
  const rows = cycle.manifests.map((item) => [
    escapeHtml(String(item.iteration)),
    item.doc === null ? '<span class="muted">не прочитано</span>' : value(item.doc.totals?.files),
    item.doc === null ? '' : value(item.doc.totals?.bytes),
    item.doc === null ? '' : value(item.doc.totals?.lines),
  ]);
  return table(['итерация', 'файлов', 'байт', 'строк'], rows);
}

/**
 * Отчёты агентов: просмотрщик показывает, что они есть и сколько весят; разбирать markdown —
 * работа ядра, а не UI (ADR 0006, а).
 * @param {Record<string, any>} cycle
 * @returns {string}
 */
function reportsBlock(cycle) {
  if (cycle.reports.length === 0) return '<p class="muted">отчётов агентов нет</p>';
  const rows = cycle.reports.map((report) => [
    escapeHtml(report.kind),
    escapeHtml(String(report.iteration)),
    report.present ? value(report.bytes) : '<span class="muted">нет файла</span>',
  ]);
  return table(['отчёт', 'итерация', 'байт'], rows);
}

/**
 * Раздел одного цикла.
 * @param {Record<string, any>} cycle
 * @param {number} index
 * @param {{ maxDiffBytes: number }} options
 * @returns {string}
 */
function cycleSection(cycle, index, options) {
  const state = cycle.state?.doc ?? {};
  const issue = state.issue === undefined ? '' : ` · #${escapeHtml(String(state.issue))}`;
  return `<section id="cycle-${index}">
<h2>${escapeHtml(String(cycle.slug))}${issue}</h2>
${problemsBlock(cycle.problems)}
<h3>Состояние</h3>
${cycleFacts(cycle)}
<h3>Причина остановки</h3>
${stopReason(cycle)}
<h3>Решения</h3>
${decisionsBlock(cycle)}
<h3>Гейты</h3>
${gatesBlock(cycle)}
<h3>Пакет evidence</h3>
${evidenceBlock(cycle, options)}
<h3>Манифесты</h3>
${manifestsBlock(cycle)}
<h3>Отчёты агентов</h3>
${reportsBlock(cycle)}
</section>`;
}

/**
 * Строка сводки по циклу для оглавления.
 * @param {Record<string, any>} cycle
 * @param {number} index
 * @returns {string[]}
 */
function indexRow(cycle, index) {
  const state = cycle.state?.doc ?? {};
  const metrics = cycle.metrics?.doc ?? {};
  const latest = latestDecision(cycle.decisions);
  return [
    `<a href="#cycle-${index}">${escapeHtml(String(cycle.slug))}</a>`,
    value(state.issue),
    `${value(state.stage)} / ${value(state.stage_status)}`,
    value(state.iteration),
    latest === null || latest.doc === null ? '<span class="muted">нет данных</span>' : value(latest.doc.action),
    value(metrics.cost_rub),
    cycle.problems.length === 0
      ? '<span class="muted">—</span>'
      : `<span class="bad">${escapeHtml(String(cycle.problems.length))}</span>`,
  ];
}

/** Стили внутри страницы: внешний css — это сеть, а сеть запрещена (ADR 0006, в). */
const STYLES = `
:root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; --bad: #b91c1c; --bg: #f9fafb; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 70rem; padding: 2rem 1.25rem 4rem; font: 16px/1.5 system-ui, sans-serif; }
h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
h2 { font-size: 1.25rem; margin: 2.5rem 0 .5rem; border-bottom: 1px solid var(--line); padding-bottom: .35rem; }
h3 { font-size: 1rem; margin: 1.5rem 0 .5rem; }
h4 { font-size: .9rem; margin: 1rem 0 .35rem; color: var(--muted); font-weight: 600; }
table { border-collapse: collapse; width: 100%; font-size: .9rem; margin: .25rem 0 .5rem; }
th, td { text-align: left; padding: .35rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-weight: 600; }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; }
pre { overflow: auto; max-height: 32rem; padding: .75rem; background: var(--bg); border: 1px solid var(--line); }
dl.facts { display: grid; grid-template-columns: 14rem 1fr; gap: .15rem .75rem; margin: 0; font-size: .9rem; }
dl.facts dt { color: var(--muted); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.muted { color: var(--muted); }
.bad { color: var(--bad); font-weight: 600; }
.problem { border-left: 3px solid var(--bad); padding: .35rem .75rem; margin: .5rem 0 1rem; }
details { margin: .25rem 0 .75rem; }
summary { cursor: pointer; font-weight: 600; }
@media (prefers-color-scheme: dark) {
  :root { --muted: #9ca3af; --line: #374151; --bad: #f87171; --bg: #111827; }
}
`;

/**
 * Страница просмотрщика целиком. Чистая функция: вход — прочитанное дерево, выход — HTML.
 * @param {{
 *   artifactsDir: string,
 *   cycles: Record<string, any>[],
 *   problems: string[],
 *   maxDiffBytes: number,
 * }} input
 * @returns {string}
 */
export function renderPage({ artifactsDir, cycles, problems, maxDiffBytes }) {
  const options = { maxDiffBytes };
  const index =
    cycles.length === 0
      ? '<p class="muted">циклов в дереве нет</p>'
      : table(
          ['цикл', 'issue', 'стадия', 'итерация', 'решение', 'стоимость', 'проблемы'],
          cycles.map(indexRow),
        );

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Артефакты цикла</title>
<style>${STYLES}</style>
</head>
<body>
<h1>Артефакты цикла</h1>
<p class="muted">Источник: <code>${escapeHtml(artifactsDir)}</code> · циклов: ${escapeHtml(
    String(cycles.length),
  )} · страница собрана из файлов ядра, без сети и JS; просмотрщик ничего не записывает.</p>
${problemsBlock(problems)}
<h2>Список циклов</h2>
${index}
${cycles.map((cycle, indexNumber) => cycleSection(cycle, indexNumber, options)).join('\n')}
</body>
</html>
`;
}
