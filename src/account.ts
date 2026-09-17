import {
  listLiveAngelNames,
  listPendingAngelNameRequestsForUser,
  maxAngelNames,
  STANDARD_ANGEL_NAME_CAP,
} from "./db/angelNames";
import {
  getSubscriptionForUser,
  isSubscriptionActive,
} from "./db/subscriptions";
import { toPublicUser, type User } from "./db/users";

export async function buildAccountPayload(user: User) {
  const [names, extraSlots, subscription, pendingRequests] = await Promise.all([
    listLiveAngelNames(user.id),
    Promise.resolve(user.extra_angel_slots ?? 0),
    getSubscriptionForUser(user.id),
    listPendingAngelNameRequestsForUser(user.id),
  ]);
  const extra = Math.max(0, extraSlots);
  return {
    user: toPublicUser(user),
    angel_names: names.map((n) => ({
      id: n.id,
      name: n.name,
      slot_kind: n.slot_kind,
      created_at: n.created_at,
    })),
    extra_angel_slots: extra,
    max_angel_names: maxAngelNames(extra),
    standard_angel_name_cap: STANDARD_ANGEL_NAME_CAP,
    subscription: subscription
      ? {
          status: subscription.status,
          active: isSubscriptionActive(subscription),
          current_period_end: subscription.current_period_end,
          cancel_at_period_end: subscription.cancel_at_period_end,
        }
      : null,
    pending_name_requests: pendingRequests.map((r) => ({
      id: r.id,
      type: r.type,
      angel_name_id: r.angel_name_id,
      requested_name: r.requested_name,
      status: r.status,
      created_at: r.created_at,
    })),
  };
}
