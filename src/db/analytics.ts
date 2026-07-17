import crypto from "crypto";
import { query } from "./pool";

/**
 * Privacy-friendly analytics storage.
 * We never store IP addresses or any personal data — only a salted hash of a
 * random, client-generated visitor id, the path, the referrer's hostname,
 * and a coarse device bucket.
 */

const KNOWN_DEVICES = new Set(["mobile", "tablet", "desktop"]);

function hashVisitorId(visitorId: string): string {
  const salt = process.env.ANALYTICS_SALT?.trim() || "aag-analytics-v1";
  return crypto
    .createHash("sha256")
    .update(salt + ":" + visitorId)
    .digest("hex");
}

export async function recordPageView(input: {
  visitor_id: string;
  path: string;
  referrer_host: string | null;
  device: string | null;
}): Promise<void> {
  const device =
    input.device && KNOWN_DEVICES.has(input.device) ? input.device : null;
  await query(
    `INSERT INTO page_views (visitor_key, path, referrer_host, device)
     VALUES ($1, $2, $3, $4)`,
    [hashVisitorId(input.visitor_id), input.path, input.referrer_host, device]
  );
}

export interface DailyTraffic {
  day: string;
  views: number;
  visitors: number;
  new_visitors: number;
  returning_visitors: number;
}

export interface AnalyticsSummary {
  range_days: number;
  totals: {
    views: number;
    visitors: number;
    new_visitors: number;
    returning_visitors: number;
    returning_rate: number;
    views_per_visitor: number;
    submissions: number;
    newsletter_subscribers: number;
    contact_messages: number;
  };
  daily: DailyTraffic[];
  submissions_daily: { day: string; count: number }[];
  top_pages: { path: string; views: number; visitors: number }[];
  top_referrers: { referrer_host: string; views: number }[];
  devices: { device: string; views: number }[];
}

function dayKey(value: unknown): string {
  const d = value instanceof Date ? value : new Date(String(value));
  return d.toISOString().slice(0, 10);
}

/** Build a continuous list of day keys (UTC) covering the last N days. */
function dayRange(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export async function getAnalyticsSummary(
  days: number
): Promise<AnalyticsSummary> {
  const rangeDays = Math.min(Math.max(Math.floor(days) || 30, 1), 365);

  // Per-day views / visitors / new visitors. A "new" visitor's first-ever
  // page view falls on that day; everyone else that day is returning.
  const dailyRes = await query(
    `WITH firsts AS (
       SELECT visitor_key, MIN(created_at) AS first_seen
       FROM page_views
       GROUP BY visitor_key
     ),
     in_range AS (
       SELECT
         date_trunc('day', pv.created_at AT TIME ZONE 'UTC') AS day,
         pv.visitor_key,
         f.first_seen
       FROM page_views pv
       JOIN firsts f USING (visitor_key)
       WHERE pv.created_at > NOW() - make_interval(days => $1::int)
     )
     SELECT
       day,
       COUNT(*)::int AS views,
       COUNT(DISTINCT visitor_key)::int AS visitors,
       COUNT(DISTINCT visitor_key)
         FILTER (
           WHERE date_trunc('day', first_seen AT TIME ZONE 'UTC') = day
         )::int AS new_visitors
     FROM in_range
     GROUP BY day
     ORDER BY day`,
    [rangeDays]
  );

  const byDay = new Map<string, DailyTraffic>();
  for (const row of dailyRes.rows) {
    const key = dayKey(row.day);
    const views = Number(row.views);
    const visitors = Number(row.visitors);
    const newVisitors = Number(row.new_visitors);
    byDay.set(key, {
      day: key,
      views,
      visitors,
      new_visitors: newVisitors,
      returning_visitors: Math.max(visitors - newVisitors, 0),
    });
  }

  const daily: DailyTraffic[] = dayRange(rangeDays).map(
    (day) =>
      byDay.get(day) ?? {
        day,
        views: 0,
        visitors: 0,
        new_visitors: 0,
        returning_visitors: 0,
      }
  );

  // Range totals. A visitor counts as "returning" when they either visited
  // before the window started, or came back on more than one day within it.
  const totalsRes = await query(
    `WITH firsts AS (
       SELECT visitor_key, MIN(created_at) AS first_seen
       FROM page_views
       GROUP BY visitor_key
     ),
     per_visitor AS (
       SELECT
         pv.visitor_key,
         COUNT(*)::int AS views,
         COUNT(DISTINCT date_trunc('day', pv.created_at AT TIME ZONE 'UTC'))::int AS days_active,
         MIN(f.first_seen) AS first_seen
       FROM page_views pv
       JOIN firsts f USING (visitor_key)
       WHERE pv.created_at > NOW() - make_interval(days => $1::int)
       GROUP BY pv.visitor_key
     )
     SELECT
       COALESCE(SUM(views), 0)::int AS views,
       COUNT(*)::int AS visitors,
       COUNT(*) FILTER (
         WHERE first_seen <= NOW() - make_interval(days => $1::int)
            OR days_active > 1
       )::int AS returning_visitors
     FROM per_visitor`,
    [rangeDays]
  );
  const totalsRow = totalsRes.rows[0] ?? {};
  const views = Number(totalsRow.views) || 0;
  const visitors = Number(totalsRow.visitors) || 0;
  const returningVisitors = Number(totalsRow.returning_visitors) || 0;
  const newVisitors = Math.max(visitors - returningVisitors, 0);

  const topPagesRes = await query(
    `SELECT path,
            COUNT(*)::int AS views,
            COUNT(DISTINCT visitor_key)::int AS visitors
     FROM page_views
     WHERE created_at > NOW() - make_interval(days => $1::int)
     GROUP BY path
     ORDER BY views DESC
     LIMIT 8`,
    [rangeDays]
  );

  const topReferrersRes = await query(
    `SELECT referrer_host, COUNT(*)::int AS views
     FROM page_views
     WHERE created_at > NOW() - make_interval(days => $1::int)
       AND referrer_host IS NOT NULL
       AND referrer_host <> ''
     GROUP BY referrer_host
     ORDER BY views DESC
     LIMIT 8`,
    [rangeDays]
  );

  const devicesRes = await query(
    `SELECT COALESCE(device, 'other') AS device, COUNT(*)::int AS views
     FROM page_views
     WHERE created_at > NOW() - make_interval(days => $1::int)
     GROUP BY 1
     ORDER BY views DESC`,
    [rangeDays]
  );

  const submissionsDailyRes = await query(
    `SELECT date_trunc('day', created_at AT TIME ZONE 'UTC') AS day,
            COUNT(*)::int AS count
     FROM entries
     WHERE created_at > NOW() - make_interval(days => $1::int)
     GROUP BY day
     ORDER BY day`,
    [rangeDays]
  );
  const submissionsByDay = new Map<string, number>();
  for (const row of submissionsDailyRes.rows) {
    submissionsByDay.set(dayKey(row.day), Number(row.count));
  }
  const submissionsDaily = dayRange(rangeDays).map((day) => ({
    day,
    count: submissionsByDay.get(day) ?? 0,
  }));

  const businessRes = await query(
    `SELECT
       (SELECT COUNT(*) FROM entries
         WHERE created_at > NOW() - make_interval(days => $1::int))::int AS submissions,
       (SELECT COUNT(*) FROM newsletter_subscribers)::int AS newsletter_subscribers,
       (SELECT COUNT(*) FROM contact_messages)::int AS contact_messages`,
    [rangeDays]
  );
  const business = businessRes.rows[0] ?? {};

  return {
    range_days: rangeDays,
    totals: {
      views,
      visitors,
      new_visitors: newVisitors,
      returning_visitors: returningVisitors,
      returning_rate: visitors > 0 ? Math.round((returningVisitors / visitors) * 100) : 0,
      views_per_visitor: visitors > 0 ? Math.round((views / visitors) * 10) / 10 : 0,
      submissions: Number(business.submissions) || 0,
      newsletter_subscribers: Number(business.newsletter_subscribers) || 0,
      contact_messages: Number(business.contact_messages) || 0,
    },
    daily,
    submissions_daily: submissionsDaily,
    top_pages: topPagesRes.rows.map((row) => ({
      path: String(row.path),
      views: Number(row.views),
      visitors: Number(row.visitors),
    })),
    top_referrers: topReferrersRes.rows.map((row) => ({
      referrer_host: String(row.referrer_host),
      views: Number(row.views),
    })),
    devices: devicesRes.rows.map((row) => ({
      device: String(row.device),
      views: Number(row.views),
    })),
  };
}
