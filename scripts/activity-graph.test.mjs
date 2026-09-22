import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createDateRange,
  escapeXml,
  extractDailyContributions,
  fetchContributions,
  generateActivityGraph,
  renderActivityGraph,
} from './activity-graph.mjs';

const now = new Date('2026-09-22T03:15:00.000Z');
const range = createDateRange(now);
const makeDays = (count = 0) => range.dates.map((date, i) => ({
  date,
  contributionCount: typeof count === 'function' ? count(i) : count,
}));
const response = (days = makeDays()) => ({ data: { user: {
  contributionsCollection: { contributionCalendar: {
    weeks: Array.from({ length: Math.ceil(days.length / 7) }, (_, i) => ({
      contributionDays: days.slice(i * 7, (i + 1) * 7),
    })),
  } },
} } });
const apiResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

test('last 31 UTC dates include today and cross month/year/leap-day boundaries', () => {
  assert.equal(range.dates.length, 31);
  assert.equal(range.from, '2026-08-23T00:00:00.000Z');
  assert.equal(range.to, now.toISOString());
  assert.equal(range.dates.at(-1), '2026-09-22');
  assert.equal(createDateRange(new Date('2026-01-01T01:00:00+03:00')).dates.at(-1), '2025-12-31');
  assert.ok(createDateRange(new Date('2024-03-01T12:00:00Z')).dates.includes('2024-02-29'));
  assert.throws(() => createDateRange(new Date('invalid')), /date/i);
});

test('complete zero-count series is valid, ordered, and is not substituted with fake data', () => {
  const days = makeDays();
  assert.deepEqual(extractDailyContributions(response([...days].reverse()), range), days);
  const svg = renderActivityGraph(days, { username: 'furqanfsl' });
  assert.match(svg, /0 contributions/);
  assert.match(svg, /0 active days/);
  assert.match(svg, /No contributions in this period/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.doesNotMatch(svg, /class="bar"/);
});

test('calendar padding is filtered without manufacturing missing dates', () => {
  const padded = [{ date: '2026-08-22', contributionCount: 99 }, ...makeDays(1),
    { date: '2026-09-23', contributionCount: 99 }];
  assert.deepEqual(extractDailyContributions(response(padded), range), makeDays(1));
});

test('missing, duplicate, malformed and non-integer daily records are rejected', () => {
  for (const invalid of [
    makeDays().slice(1),
    [...makeDays(), makeDays()[0]],
    makeDays().map((day, i) => i === 1 ? { ...day, date: '2026-08-99' } : day),
    makeDays().map((day, i) => i === 1 ? { ...day, date: '2026-9-01' } : day),
    ...[-1, 1.5, '2', null, Infinity, Number.MAX_SAFE_INTEGER + 1].map(contributionCount =>
      makeDays().map((day, i) => i === 1 ? { ...day, contributionCount } : day)),
  ]) {
    assert.throws(() => extractDailyContributions(response(invalid), range), /calendar|contribution|date|duplicate|complete/i);
  }
});

test('null user, malformed schema, and GraphQL partial errors do not become zero charts', () => {
  for (const payload of [null, {}, { data: { user: null } },
    { ...response(), errors: [{ message: 'Rate limit exceeded' }] },
    { data: { user: { contributionsCollection: { contributionCalendar: { weeks: [null] } } } } },
  ]) {
    assert.throws(() => extractDailyContributions(payload, range));
  }
});

test('SVG escapes XML and exposes an accessible title, summary, and daily counts', () => {
  assert.equal(escapeXml(`A&B <C> "D" 'E'`), 'A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;');
  const svg = renderActivityGraph(makeDays(i => i === 2 ? 1 : 0), {
    username: '<script>&"\'example',
  });
  assert.match(svg, /role="img" aria-labelledby="title description"/);
  assert.match(svg, /<title id="title">Contribution activity<\/title>/);
  assert.match(svg, /1 contribution · 1 active day/);
  assert.match(svg, /2026-08-25: 1 contribution/);
  assert.match(svg, /&lt;script&gt;&amp;&quot;&apos;example/);
  assert.doesNotMatch(svg, /<script>/);
});

test('high counts remain finite and rendering independently validates series', () => {
  const svg = renderActivityGraph(makeDays(i => i === 5 ? 2147483647 : 0));
  assert.match(svg, /2,147,483,647 contributions/);
  assert.doesNotMatch(svg, /NaN|Infinity/);
  assert.throws(() => renderActivityGraph([]), /31|complete/i);
  assert.throws(() => renderActivityGraph(makeDays().reverse()), /date|order|consecutive/i);
  assert.throws(() => renderActivityGraph(makeDays(Number.MAX_SAFE_INTEGER)), /total|safe/i);
});

test('compact SVG has a separate mobile viewBox and readable text sizes', () => {
  const svg = renderActivityGraph(makeDays(i => i === 30 ? 6 : 0), { compact: true });
  assert.match(svg, /width="360" height="250" viewBox="0 0 360 250"/);
  assert.match(svg, /font-size="18"/);
  assert.match(svg, /6 contributions · 1 active day/);
  assert.equal((svg.match(/class="bar"/g) ?? []).length, 1);
});

test('API uses explicit UTC bounds, GitHub-only authentication, and an abort signal', async () => {
  let captured;
  const days = await fetchContributions({
    username: 'furqanfsl', token: 'test-token', now,
    fetchImpl: async (...args) => { captured = args; return apiResponse(response(makeDays(1))); },
  });
  assert.deepEqual(days, makeDays(1));
  const [url, options] = captured;
  assert.equal(url, 'https://api.github.com/graphql');
  assert.equal(options.headers.Authorization, 'Bearer test-token');
  assert.equal(options.redirect, 'error');
  assert.ok(options.signal instanceof AbortSignal);
  const { query, variables } = JSON.parse(options.body);
  assert.match(query, /contributionsCollection\(from: \$from, to: \$to\)/);
  assert.deepEqual(variables, { login: 'furqanfsl', from: range.from, to: range.to });
});

test('credentials and login are validated before network access', async () => {
  const fetchImpl = () => assert.fail('must not fetch');
  await assert.rejects(fetchContributions({ username: 'furqanfsl', token: '', fetchImpl }), /GITHUB_TOKEN/);
  await assert.rejects(fetchContributions({ username: 'bad/login', token: 'token', fetchImpl }), /username/i);
});

test('HTTP, GraphQL, malformed JSON and timeout failures preserve the previous good SVG', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'profile-activity-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outputPath = join(dir, 'activity.svg');
  const mobilePath = join(dir, 'activity-mobile.svg');
  const previous = '<svg xmlns="http://www.w3.org/2000/svg"><title>Previous good chart</title></svg>';
  const failures = [
    async () => apiResponse({ message: 'unavailable' }, 503),
    async () => apiResponse({ errors: [{ message: 'Rate limit exceeded' }] }),
    async () => new Response('not-json', { status: 200 }),
    async () => apiResponse(response(makeDays().slice(1))),
    async () => { throw new DOMException('Timed out', 'TimeoutError'); },
  ];
  for (const fetchImpl of failures) {
    await writeFile(outputPath, previous);
    await writeFile(mobilePath, previous);
    await assert.rejects(generateActivityGraph({
      username: 'furqanfsl', token: 'test-token', now, outputPath, fetchImpl,
    }));
    assert.equal(await readFile(outputPath, 'utf8'), previous);
    assert.equal(await readFile(mobilePath, 'utf8'), previous);
  }
});

test('successful generation writes an SVG only after complete validated data arrives', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'profile-activity-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outputPath = join(dir, 'nested', 'activity.svg');
  await generateActivityGraph({ username: 'furqanfsl', token: 'test-token', now, outputPath,
    fetchImpl: async () => apiResponse(response(makeDays(2))),
  });
  assert.match(await readFile(outputPath, 'utf8'), /62 contributions · 31 active days/);
  assert.match(await readFile(join(dir, 'nested', 'activity-mobile.svg'), 'utf8'), /viewBox="0 0 360 250"/);
});
