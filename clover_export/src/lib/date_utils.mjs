/**
 * Date utility functions for Clover reporting.
 */

export function formatDate(dt) {
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

export function parseDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

export function getTodayStr() {
  return formatDate(new Date());
}

/**
 * Returns timestamps for a single calendar day (00:00:00.000 to 23:59:59.000 local time).
 * Millisecond value is strictly 000 to ensure compatibility with Clover.
 */
export function getDayTimestamps(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 0);

  return {
    startTimestamp: start.getTime(),
    endTimestamp: end.getTime()
  };
}

/**
 * Expands a date range [startDateStr, endDateStr] into an array of YYYY-MM-DD strings.
 */
export function expandDateRange(startDateStr, endDateStr) {
  const dates = [];
  const current = parseDate(startDateStr);
  const end = parseDate(endDateStr);

  while (current.getTime() <= end.getTime()) {
    dates.push(formatDate(current));
    current.setDate(current.getDate() + 1);
  }

  return dates;
}
