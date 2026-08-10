from datetime import timedelta
from app.models import DeliveryIntent
from app.admin.pipeline_alerts import PipelineAlert
from app.notifications.email import send_failure_email
from app.vault import vault_controls

STUCK_THRESHOLD = timedelta(minutes=10)

class FailureAlertObserver:
    def on_status_change(self, intent: DeliveryIntent):
        if intent.status in ('failed', 'escalated'):
            self._emit_alert(intent, 'terminal_failure')
        elif intent.is_stuck(STUCK_THRESHOLD):
            self._emit_alert(intent, 'stuck_threshold')

    def _emit_alert(self, intent, reason):
        alert = PipelineAlert.create(
            entry_id=intent.id,
            angel_name=intent.angel_name,
            status=intent.status,
            reason=reason,
            link=f"/admin/requests/{intent.id}"
        )
        send_failure_email(alert)
        # Slack optional via existing webhook if configured

    def quick_retry(self, intent_id, admin):
        intent = DeliveryIntent.get(intent_id)
        if intent.can_safe_retry():
            intent.schedule_one_more_send(admin)
            alert = PipelineAlert.get_for(intent)
            alert.acknowledge(admin)

    def acknowledge(self, alert_id, admin):
        PipelineAlert.get(alert_id).acknowledge(admin)