import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_COUNT = 31;
const API_URL = 'https://api.github.com/graphql';
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const number = new Intl.NumberFormat('en-US');
const compactNumber = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dateLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

const QUERY = `query ProfileActivity($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks { contributionDays { date contributionCount } }
      }
    }
  }
}`;

/** Include today (which may be incomplete), using UTC rather than runner locale. */
export function createDateRange(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error('A valid date is required.');
  }
  const today = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
  const start = today - (DAY_COUNT - 1) * DAY_MS;
  return {
    from: new Date(start).toISOString(),
    to: now.toISOString(),
    dates: Array.from({ length: DAY_COUNT }, (_, i) => new Date(start + i * DAY_MS).toISOString().slice(0, 10)),
  };
}

function validDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function validateDay(day) {
  if (!day || !validDate(day.date)) throw new Error('Contribution calendar contains an invalid date.');
  if (!Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0) {
    throw new Error('Contribution calendar contains an invalid contribution count.');
  }
}

function validateSeries(days) {
  if (!Array.isArray(days) || days.length !== DAY_COUNT) {
    throw new Error('A complete 31-day contribution series is required.');
  }
  let total = 0;
  days.forEach((day, i) => {
    validateDay(day);
    if (i && Date.parse(day.date) - Date.parse(days[i - 1].date) !== DAY_MS) {
      throw new Error('Contribution dates must be consecutive and ordered.');
    }
    total += day.contributionCount;
    if (!Number.isSafeInteger(total)) throw new Error('Contribution total exceeds the safe integer range.');
  });
  return total;
}

/** Never turn missing API data into fabricated zero-contribution days. */
export function extractDailyContributions(payload, range) {
  if (payload?.errors && (!Array.isArray(payload.errors) || payload.errors.length)) {
    throw new Error('GitHub GraphQL returned errors; keeping the previous activity graph.');
  }
  const weeks = payload?.data?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks) || weeks.length === 0) {
    throw new Error('GitHub returned an invalid contribution calendar.');
  }
  const byDate = new Map();
  for (const week of weeks) {
    if (!Array.isArray(week?.contributionDays)) {
      throw new Error('GitHub returned a malformed contribution calendar week.');
    }
    for (const day of week.contributionDays) {
      validateDay(day);
      if (byDate.has(day.date)) throw new Error('Contribution calendar contains duplicate dates.');
      byDate.set(day.date, { date: day.date, contributionCount: day.contributionCount });
    }
  }
  const days = range.dates.map(date => {
    const day = byDate.get(date);
    if (!day) throw new Error(`Contribution calendar is incomplete: missing ${date}.`);
    return day;
  });
  validateSeries(days);
  return days;
}

export function escapeXml(value) {
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    })[character]);
}

export async function fetchContributions({
  username, token, now = new Date(), fetchImpl = fetch, timeoutMs = 15_000,
} = {}) {
  if (typeof token !== 'string' || !token.trim()) throw new Error('GITHUB_TOKEN is required.');
  if (typeof username !== 'string' || !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username)) {
    throw new Error('A valid GitHub username is required.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('A positive timeout is required.');
  const range = createDateRange(now);
  // Do not follow redirects: the credential must only be sent to api.github.com.
  const result = await fetchImpl(API_URL, {
    method: 'POST',
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'github-profile-activity-graph',
    },
    body: JSON.stringify({ query: QUERY, variables: { login: username, from: range.from, to: range.to } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!result.ok) throw new Error(`GitHub API returned HTTP ${result.status}; keeping the previous activity graph.`);
  return extractDailyContributions(await result.json(), range);
}

function label(date) {
  return dateLabel.format(new Date(`${date}T00:00:00.000Z`));
}

function countPhrase(count) {
  return `${number.format(count)} contribution${count === 1 ? '' : 's'}`;
}

/** Separate compact asset keeps chart labels readable in narrow GitHub profiles. */
export function renderActivityGraph(days, { username = 'furqanfsl', compact = false } = {}) {
  const total = validateSeries(days);
  const activeDays = days.filter(day => day.contributionCount > 0).length;
  const max = Math.max(...days.map(day => day.contributionCount));
  const ceiling = max <= 1 ? 1 : Math.ceil(max / 2) * 2;
  const width = compact ? 360 : 720;
  const height = compact ? 250 : 280;
  const inset = compact ? 20 : 28;
  const left = compact ? 44 : 64;
  const right = width - inset;
  const top = compact ? 101 : 104;
  const bottom = compact ? 194 : 215;
  const chartWidth = right - left;
  const step = chartWidth / DAY_COUNT;
  const x = i => left + step * (i + 0.5);
  const y = count => bottom - count / ceiling * (bottom - top);
  const n = value => Number(value.toFixed(2));
  const firstDate = days[0].date;
  const lastDate = days.at(-1).date;
  const period = `${label(firstDate)} – ${label(lastDate)}`;
  const totalLabel = compact && total > 999_999 ? `${compactNumber.format(total)} contributions` : countPhrase(total);
  const summary = `${totalLabel} · ${activeDays} active day${activeDays === 1 ? '' : 's'}`;
  const description = `${username}: ${countPhrase(total)} across ${DAY_COUNT} days, ${firstDate} to ${lastDate} (UTC). ` +
    `Today may be incomplete. Daily counts: ${days.map(day => `${day.date}: ${countPhrase(day.contributionCount)}`).join('; ')}.`;
  const ticks = ceiling === 1 ? [0, 1] : [0, ceiling / 2, ceiling];
  const grid = ticks.map(tick => `<line x1="${left}" y1="${n(y(tick))}" x2="${right}" y2="${n(y(tick))}" stroke="#30363D"/>
    <text x="${left - 9}" y="${n(y(tick) + 4)}" text-anchor="end" font-size="${compact ? 12 : 14}" fill="#A8B1BD">${escapeXml(compactNumber.format(tick))}</text>`).join('\n');
  const bars = days.filter(day => day.contributionCount > 0).map(day => {
    const i = days.indexOf(day);
    const barWidth = step * 0.66;
    return `<rect class="bar" x="${n(x(i) - barWidth / 2)}" y="${n(y(day.contributionCount))}" width="${n(barWidth)}" height="${n(bottom - y(day.contributionCount))}" rx="1.5" fill="#A78BFA"><title>${escapeXml(`${day.date}: ${countPhrase(day.contributionCount)}`)}</title></rect>`;
  }).join('\n');
  const dateIndices = compact ? [0, 15, 30] : [0, 7, 15, 23, 30];
  const dates = dateIndices.map(i => `<text x="${n(i === 0 ? left : i === 30 ? right : x(i))}" y="${bottom + 22}" text-anchor="${i === 0 ? 'start' : i === 30 ? 'end' : 'middle'}" font-size="${compact ? 12 : 14}" fill="#A8B1BD">${escapeXml(label(days[i].date))}</text>`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">Contribution activity</title>
  <desc id="description">${escapeXml(description)}</desc>
  <rect width="${width}" height="${height}" rx="8" fill="#0D1117"/>
  <g font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif">
    <text x="${inset}" y="${compact ? 31 : 35}" font-size="${compact ? 18 : 22}" font-weight="600" fill="#A78BFA">Contribution activity</text>
    <text x="${inset}" y="${compact ? 55 : 62}" font-size="${compact ? 14 : 18}" fill="#E5E7EB">${escapeXml(summary)}</text>
    <text x="${compact ? inset : right}" y="${compact ? 78 : 35}" text-anchor="${compact ? 'start' : 'end'}" font-size="${compact ? 12 : 14}" fill="#A8B1BD">${escapeXml(period)} · UTC</text>
    ${grid}
    ${bars}
    ${total === 0 ? `<text x="${n((left + right) / 2)}" y="${n((top + bottom) / 2 + 5)}" text-anchor="middle" font-size="${compact ? 13 : 16}" fill="#E5E7EB">No contributions in this period</text>` : ''}
    ${dates}
    <text x="${inset}" y="${height - 12}" font-size="${compact ? 11 : 12}" fill="#A8B1BD">Last 31 days · Today may be incomplete</text>
  </g>
</svg>\n`;
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function generateActivityGraph({
  username = process.env.GH_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || 'furqanfsl',
  token = process.env.GITHUB_TOKEN,
  now = new Date(),
  outputPath = join(ROOT, 'profile', 'activity.svg'),
  mobileOutputPath,
  fetchImpl = fetch,
} = {}) {
  const days = await fetchContributions({ username, token, now, fetchImpl });
  const desktopSvg = renderActivityGraph(days, { username });
  const mobileSvg = renderActivityGraph(days, { username, compact: true });
  const mobilePath = mobileOutputPath ?? join(dirname(outputPath), 'activity-mobile.svg');
  // All network, validation and rendering must succeed before either file changes.
  await atomicWrite(outputPath, desktopSvg);
  await atomicWrite(mobilePath, mobileSvg);
  return { outputPath, mobileOutputPath: mobilePath, days };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  generateActivityGraph().then(({ days }) => {
    console.log(`Updated activity graphs with ${days.length} validated days of GitHub contributions.`);
  }).catch(error => {
    // Never print request headers, tokens, or untrusted API response bodies.
    console.error(`Activity graph update failed: ${error.message}`);
    process.exitCode = 1;
  });
}
