import { sendFailureEmail } from '../email/failureMailer';
import { postToSlack } from '../slack/webhook';
import { createBanner } from '../admin/pipelineAlerts';

export async function triggerFailureAlert(entry: any, reason: string) {
  if (entry.alertAcknowledged) return;
  const context = { id: entry.id, angel: entry.angelName, status: entry.status, reason, failedAt: new Date() };
  await createBanner(context);
  await sendFailureEmail(context);
  if (process.env.SLACK_WEBHOOK) await postToSlack(context);
}

export async function quickRetry(entryId: string) {
  // respects delivery-intent unique key
  await fetch(`/api/entries/${entryId}/retry`, { method: 'POST' });
}

export async function acknowledgeAlert(entryId: string) {
  await fetch(`/api/entries/${entryId}/ack`, { method: 'POST' });
}