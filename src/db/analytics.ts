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

export type AnalyticsGranularity = "hour" | "day";

export interface AnalyticsSummary {
  range_days: number;
  granularity: AnalyticsGranularity;
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

/** Parse a UTC day/hour key returned from SQL to_char (not a JS Date). */
function bucketKeyFromSql(value: unknown, granularity: AnalyticsGranularity): string {
  const raw = String(value ?? "");
  if (granularity === "hour") {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2})/);
    if (m) return `${m[1]}T${m[2]}:00:00.000Z`;
  } else {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  const d = value instanceof Date ? value : new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  if (granularity === "hour") {
    const utc = Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      d.getUTCHours()
    );
    return new Date(utc).toISOString();
  }
  return d.toISOString().slice(0, 10);
}

/** Build a continuous list of day keys (UTC) covering the last N days. */
function dayRange(days: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i)
    );
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Build a continuous list of hour keys (UTC) covering the last N hours. */
function hourRange(hours: number): string[] {
  const out: string[] = [];
  const now = new Date();
  const currentHour = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    now.getUTCHours()
  );
  for (let i = hours - 1; i >= 0; i--) {
    out.push(new Date(currentHour - i * 3_600_000).toISOString());
  }
  return out;
}

export async function getAnalyticsSummary(
  days: number
): Promise<AnalyticsSummary> {
  const rangeDays = Math.min(Math.max(Math.floor(days) || 30, 1), 365);
  const granularity: AnalyticsGranularity = rangeDays === 1 ? "hour" : "day";
  const truncUnit = granularity === "hour" ? "hour" : "day";
  const bucketFmt =
    granularity === "hour"
      ? 'YYYY-MM-DD"T"HH24:00:00.000"Z"'
      : "YYYY-MM-DD";
  const bucketKeys =
    granularity === "hour" ? hourRange(24) : dayRange(rangeDays);

  // Per-bucket views / visitors / new visitors. A "new" visitor's first-ever
  // page view falls in that bucket; everyone else in the bucket is returning.
  // Bucket keys are formatted in SQL so node-pg Date timezone parsing can't
  // shift hour/day boundaries.
  const dailyRes = await query(
    `WITH firsts AS (
       SELECT visitor_key, MIN(created_at) AS first_seen
       FROM page_views
       GROUP BY visitor_key
     ),
     in_range AS (
       SELECT
         date_trunc($2::text, pv.created_at AT TIME ZONE 'UTC') AS bucket,
         pv.visitor_key,
         f.first_seen
       FROM page_views pv
       JOIN firsts f USING (visitor_key)
       WHERE pv.created_at > NOW() - make_interval(days => $1::int)
     )
     SELECT
       to_char(bucket, $3::text) AS bucket,
       COUNT(*)::int AS views,
       COUNT(DISTINCT visitor_key)::int AS visitors,
       COUNT(DISTINCT visitor_key)
         FILTER (
           WHERE date_trunc($2::text, first_seen AT TIME ZONE 'UTC') = bucket
         )::int AS new_visitors
     FROM in_range
     GROUP BY bucket
     ORDER BY bucket`,
    [rangeDays, truncUnit, bucketFmt]
  );

  const byBucket = new Map<string, DailyTraffic>();
  for (const row of dailyRes.rows) {
    const key = bucketKeyFromSql(row.bucket, granularity);
    const views = Number(row.views);
    const visitors = Number(row.visitors);
    const newVisitors = Number(row.new_visitors);
    byBucket.set(key, {
      day: key,
      views,
      visitors,
      new_visitors: newVisitors,
      returning_visitors: Math.max(visitors - newVisitors, 0),
    });
  }

  const daily: DailyTraffic[] = bucketKeys.map(
    (day) =>
      byBucket.get(day) ?? {
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
    `SELECT to_char(
              date_trunc($2::text, created_at AT TIME ZONE 'UTC'),
              $3::text
            ) AS bucket,
            COUNT(*)::int AS count
     FROM entries
     WHERE created_at > NOW() - make_interval(days => $1::int)
     GROUP BY 1
     ORDER BY 1`,
    [rangeDays, truncUnit, bucketFmt]
  );
  const submissionsByBucket = new Map<string, number>();
  for (const row of submissionsDailyRes.rows) {
    submissionsByBucket.set(
      bucketKeyFromSql(row.bucket, granularity),
      Number(row.count)
    );
  }
  const submissionsDaily = bucketKeys.map((day) => ({
    day,
    count: submissionsByBucket.get(day) ?? 0,
  }));

  const businessRes = await query(
    `SELECT
       (SELECT COUNT(*) FROM entries
         WHERE created_at > NOW() - make_interval(days => $1::int))::int AS submissions,
       (SELECT COUNT(*) FROM newsletter_subscribers)::int AS newsletter_subscribers,
       (SELECT COUNT(*) FROM message_threads)::int AS contact_messages`,
    [rangeDays]
  );
  const business = businessRes.rows[0] ?? {};

  return {
    range_days: rangeDays,
    granularity,
    totals: {
      views,
      visitors,
      new_visitors: newVisitors,
      returning_visitors: returningVisitors,
      returning_rate:
        visitors > 0 ? Math.round((returningVisitors / visitors) * 100) : 0,
      views_per_visitor:
        visitors > 0 ? Math.round((views / visitors) * 10) / 10 : 0,
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
