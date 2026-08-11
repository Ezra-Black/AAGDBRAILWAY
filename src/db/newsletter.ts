import { query } from "./pool";

export interface NewsletterPost {
  id: string;
  title: string;
  author_name: string;
  body: string;
  image_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export const REACTION_EMOJIS = ["love", "angel", "thumbs_up"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export type ReactionCounts = Record<ReactionEmoji, number>;

export interface NewsletterPostWithReactions extends NewsletterPost {
  reactions: ReactionCounts;
  my_reactions: ReactionEmoji[];
}

export function emptyReactionCounts(): ReactionCounts {
  return { love: 0, angel: 0, thumbs_up: 0 };
}

function isReactionEmoji(value: string): value is ReactionEmoji {
  return (REACTION_EMOJIS as readonly string[]).includes(value);
}

function mapPost(row: Record<string, unknown>): NewsletterPost {
  return {
    id: String(row.id),
    title: String(row.title),
    author_name: String(row.author_name),
    body: String(row.body),
    image_url: row.image_url ? String(row.image_url) : null,
    created_at: row.created_at as Date,
    updated_at: row.updated_at as Date,
  };
}

/** Public feed — newest first. */
export async function listNewsletterPosts(limit = 100): Promise<NewsletterPost[]> {
  const result = await query(
    `SELECT id, title, author_name, body, image_url, created_at, updated_at
     FROM newsletter_posts
     ORDER BY created_at DESC
     LIMIT $1`,
    [Math.min(Math.max(limit, 1), 200)]
  );
  return result.rows.map((row) => mapPost(row as Record<string, unknown>));
}

export async function getNewsletterPostById(
  id: string
): Promise<NewsletterPost | null> {
  const result = await query(
    `SELECT id, title, author_name, body, image_url, created_at, updated_at
     FROM newsletter_posts
     WHERE id = $1
     LIMIT 1`,
    [id]
  );
  if (!result.rows[0]) return null;
  return mapPost(result.rows[0] as Record<string, unknown>);
}

export async function createNewsletterPost(input: {
  title: string;
  author_name: string;
  body: string;
  image_url?: string | null;
}): Promise<NewsletterPost> {
  const result = await query(
    `INSERT INTO newsletter_posts (title, author_name, body, image_url)
     VALUES ($1, $2, $3, $4)
     RETURNING id, title, author_name, body, image_url, created_at, updated_at`,
    [input.title, input.author_name, input.body, input.image_url ?? null]
  );
  return mapPost(result.rows[0] as Record<string, unknown>);
}

export async function deleteNewsletterPost(id: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM newsletter_posts WHERE id = $1 RETURNING id`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

/** Aggregate reaction counts for many posts at once. */
export async function getReactionCountsForPosts(
  postIds: string[]
): Promise<Map<string, ReactionCounts>> {
  const map = new Map<string, ReactionCounts>();
  for (const id of postIds) map.set(id, emptyReactionCounts());
  if (postIds.length === 0) return map;

  const result = await query(
    `SELECT post_id, emoji, COUNT(*)::int AS count
     FROM newsletter_post_reactions
     WHERE post_id = ANY($1::uuid[])
     GROUP BY post_id, emoji`,
    [postIds]
  );

  for (const row of result.rows) {
    const postId = String(row.post_id);
    const emoji = String(row.emoji);
    const counts = map.get(postId);
    if (!counts || !isReactionEmoji(emoji)) continue;
    counts[emoji] = Number(row.count) || 0;
  }
  return map;
}

/** Which reaction keys the user has toggled on for the given posts. */
export async function getMyReactionsForPosts(
  userId: string,
  postIds: string[]
): Promise<Map<string, ReactionEmoji[]>> {
  const map = new Map<string, ReactionEmoji[]>();
  for (const id of postIds) map.set(id, []);
  if (postIds.length === 0) return map;

  const result = await query(
    `SELECT post_id, emoji
     FROM newsletter_post_reactions
     WHERE user_id = $1
       AND post_id = ANY($2::uuid[])`,
    [userId, postIds]
  );

  for (const row of result.rows) {
    const postId = String(row.post_id);
    const emoji = String(row.emoji);
    if (!isReactionEmoji(emoji)) continue;
    const list = map.get(postId);
    if (list) list.push(emoji);
  }
  return map;
}

export async function getReactionSummary(
  postId: string,
  userId?: string | null
): Promise<{ reactions: ReactionCounts; my_reactions: ReactionEmoji[] }> {
  const countsMap = await getReactionCountsForPosts([postId]);
  const reactions = countsMap.get(postId) ?? emptyReactionCounts();
  let my_reactions: ReactionEmoji[] = [];
  if (userId) {
    const mine = await getMyReactionsForPosts(userId, [postId]);
    my_reactions = mine.get(postId) ?? [];
  }
  return { reactions, my_reactions };
}

/**
 * Toggle a reaction on/off for a logged-in user.
 * Returns whether the reaction is now active, plus fresh counts.
 */
export async function toggleNewsletterReaction(
  postId: string,
  userId: string,
  emoji: ReactionEmoji
): Promise<{
  active: boolean;
  reactions: ReactionCounts;
  my_reactions: ReactionEmoji[];
}> {
  const removed = await query(
    `DELETE FROM newsletter_post_reactions
     WHERE post_id = $1 AND user_id = $2 AND emoji = $3
     RETURNING id`,
    [postId, userId, emoji]
  );

  let active = false;
  if ((removed.rowCount ?? 0) === 0) {
    try {
      await query(
        `INSERT INTO newsletter_post_reactions (post_id, user_id, emoji)
         VALUES ($1, $2, $3)`,
        [postId, userId, emoji]
      );
      active = true;
    } catch (err) {
      const pgCode =
        err && typeof err === "object" && "code" in err
          ? String((err as { code: unknown }).code)
          : "";
      // Concurrent toggle landed first — treat as active.
      if (pgCode === "23505") {
        active = true;
      } else {
        throw err;
      }
    }
  }

  const summary = await getReactionSummary(postId, userId);
  return { active, ...summary };
}

/** Attach public counts (+ optional my_reactions) to a list of posts. */
export async function attachReactionsToPosts(
  posts: NewsletterPost[],
  userId?: string | null
): Promise<NewsletterPostWithReactions[]> {
  const ids = posts.map((p) => p.id);
  const counts = await getReactionCountsForPosts(ids);
  const mine = userId
    ? await getMyReactionsForPosts(userId, ids)
    : new Map<string, ReactionEmoji[]>();

  return posts.map((post) => ({
    ...post,
    reactions: counts.get(post.id) ?? emptyReactionCounts(),
    my_reactions: mine.get(post.id) ?? [],
  }));
}
