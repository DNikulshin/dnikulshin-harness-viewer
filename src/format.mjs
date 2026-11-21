/**
 * Форматирование для страницы. Отдельный модуль, потому что эти две функции — единственное место,
 * где текст из артефактов попадает в HTML, и экранирование не должно зависеть от рендера.
 */

/** Символы, которые обязаны быть экранированы: текст артефактов — не разметка. */
const ESCAPES = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
});

/**
 * Экранирует текст для вставки в HTML (в тексте и в значении атрибута).
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (character) => ESCAPES[character] ?? character);
}

/**
 * Человекочитаемый размер: байты до 1024 — как есть, дальше КБ и МБ с одним знаком.
 * @param {unknown} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  const number = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0;
  if (number < 1024) return `${number} Б`;
  if (number < 1024 * 1024) return `${(number / 1024).toFixed(1)} КБ`;
  return `${(number / (1024 * 1024)).toFixed(1)} МБ`;
}
