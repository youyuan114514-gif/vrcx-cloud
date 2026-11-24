/**
 * Pure date-grouping and timestamp-formatting helpers for the Cloud Gallery view.
 * Groups synced VRChat screenshots by local calendar day with clear date dividers
 * and explicit `YYYY年MM月DD日 HH:mm` labels above each photo.
 */

/**
 * Safely parses an ISO-8601 timestamp into a valid Date, or null when missing/invalid.
 *
 * @param {string | null | undefined} takenAt
 * @returns {Date | null}
 */
export function parseScreenshotDate(takenAt) {
    if (!takenAt) return null;
    const ms = Date.parse(takenAt);
    if (!Number.isFinite(ms)) return null;
    return new Date(ms);
}

/**
 * Pads a non-negative integer to 2 digits.
 *
 * @param {number} n
 * @returns {string}
 */
function pad2(n) {
    return String(n).padStart(2, '0');
}

/**
 * Returns whether the active locale uses Chinese year/month/day date formatting.
 *
 * @param {string} [locale]
 * @returns {boolean}
 */
function isChineseLocale(locale) {
    return typeof locale === 'string' && locale.toLowerCase().startsWith('zh');
}

/**
 * Formats a Date into a section date heading (e.g. `2026年11月24日` for zh locales, `2026-11-24` otherwise).
 *
 * @param {Date | null} date
 * @param {string} [locale]
 * @param {string} [unknownLabel]
 * @returns {string}
 */
export function formatCloudPhotoDateHeading(date, locale = 'zh-CN', unknownLabel = 'Unknown Date') {
    if (!date) return unknownLabel;
    const y = date.getFullYear();
    const m = pad2(date.getMonth() + 1);
    const d = pad2(date.getDate());
    if (isChineseLocale(locale)) {
        return `${y}年${m}月${d}日`;
    }
    return `${y}-${m}-${d}`;
}

/**
 * Formats a Date into `HH:mm`.
 *
 * @param {Date | null} date
 * @returns {string}
 */
export function formatCloudPhotoTime(date) {
    if (!date) return '';
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/**
 * Formats a screenshot's `taken_at` timestamp into `2026年11月24日 21:35` (zh) or `2026-11-24 21:35`.
 *
 * @param {string | null | undefined} takenAt
 * @param {string} [locale]
 * @param {string} [unknownLabel]
 * @returns {string}
 */
export function formatCloudPhotoDateTime(takenAt, locale = 'zh-CN', unknownLabel = 'Unknown Date') {
    const date = parseScreenshotDate(takenAt);
    if (!date) return unknownLabel;
    return `${formatCloudPhotoDateHeading(date, locale, unknownLabel)} ${formatCloudPhotoTime(date)}`;
}

/**
 * Groups an already-sorted list of cloud screenshots by local calendar day (`YYYY-MM-DD`).
 * Preserves input order inside each group and attaches preformatted `dateTimeLabel` / `timeLabel` fields.
 *
 * @template {{ id: string; taken_at?: string }} T
 * @param {T[]} screenshots
 * @param {string} [locale]
 * @param {string} [unknownLabel]
 * @returns {Array<{
 *   dateKey: string;
 *   dateLabel: string;
 *   timeRange: string;
 *   items: Array<T & { dateTimeLabel: string; timeLabel: string }>;
 * }>}
 */
export function groupCloudScreenshotsByDate(screenshots, locale = 'zh-CN', unknownLabel = 'Unknown Date') {
    if (!Array.isArray(screenshots) || screenshots.length === 0) {
        return [];
    }

    /** @type {Map<string, { dateKey: string; dateLabel: string; times: string[]; items: Array<T & { dateTimeLabel: string; timeLabel: string }> }>} */
    const groupMap = new Map();

    for (const shot of screenshots) {
        const date = parseScreenshotDate(shot?.taken_at);
        const dateKey = date
            ? `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
            : 'unknown';
        const dateLabel = formatCloudPhotoDateHeading(date, locale, unknownLabel);
        const timeLabel = formatCloudPhotoTime(date);
        const dateTimeLabel = date ? `${dateLabel} ${timeLabel}` : unknownLabel;

        let group = groupMap.get(dateKey);
        if (!group) {
            group = {
                dateKey,
                dateLabel,
                times: [],
                items: []
            };
            groupMap.set(dateKey, group);
        }
        if (timeLabel) {
            group.times.push(timeLabel);
        }
        group.items.push({
            ...shot,
            dateTimeLabel,
            timeLabel
        });
    }

    return Array.from(groupMap.values()).map((g) => {
        let timeRange = '';
        if (g.times.length === 1) {
            timeRange = g.times[0];
        } else if (g.times.length > 1) {
            const sorted = [...g.times].sort();
            const earliest = sorted[0];
            const latest = sorted[sorted.length - 1];
            timeRange = earliest === latest ? earliest : `${earliest} – ${latest}`;
        }
        return {
            dateKey: g.dateKey,
            dateLabel: g.dateLabel,
            timeRange,
            items: g.items
        };
    });
}
