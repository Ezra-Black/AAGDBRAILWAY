import { logger } from "./logger";

const GRAPH_BASE = "https://graph.facebook.com/v21.0";

export function facebookAppId(): string {
  return process.env.FB_APP_ID?.trim() || "";
}

/** Facebook login is optional — enabled only when both env vars are set. */
export function facebookConfigured(): boolean {
  return Boolean(facebookAppId() && process.env.FB_APP_SECRET?.trim());
}

export interface FacebookProfile {
  fb_user_id: string;
  name: string | null;
  email: string | null;
}

/**
 * Verify a client-side access token with Facebook, then fetch the profile.
 * Returns null when the token is invalid or was issued for a different app.
 */
export async function verifyFacebookToken(
  accessToken: string
): Promise<FacebookProfile | null> {
  const appId = facebookAppId();
  const appSecret = process.env.FB_APP_SECRET?.trim() || "";
  if (!appId || !appSecret) return null;

  const appToken = `${appId}|${appSecret}`;

  try {
    const debugRes = await fetch(
      `${GRAPH_BASE}/debug_token?` +
        new URLSearchParams({
          input_token: accessToken,
          access_token: appToken,
        }).toString()
    );
    const debugData = (await debugRes.json()) as {
      data?: { is_valid?: boolean; app_id?: string; user_id?: string };
    };

    const info = debugData.data;
    if (!debugRes.ok || !info?.is_valid || info.app_id !== appId || !info.user_id) {
      return null;
    }

    const meRes = await fetch(
      `${GRAPH_BASE}/me?` +
        new URLSearchParams({
          fields: "id,name,email",
          access_token: accessToken,
        }).toString()
    );
    const me = (await meRes.json()) as {
      id?: string;
      name?: string;
      email?: string;
    };
    if (!meRes.ok || !me.id || me.id !== info.user_id) {
      return null;
    }

    return {
      fb_user_id: me.id,
      name: me.name?.trim() || null,
      email: me.email?.trim().toLowerCase() || null,
    };
  } catch (err) {
    logger.error("Facebook token verification failed", { error: String(err) });
    return null;
  }
}
