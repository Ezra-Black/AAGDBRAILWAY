module Alerts
  class FailureAlerts
    THRESHOLD = ENV.fetch('FAILURE_ALERT_THRESHOLD_MINUTES', 8).to_i
    def self.trigger(entry)
      return if entry.alert_acknowledged?
      return unless entry.failed? || entry.stuck?(THRESHOLD)
      AdminNotification.create!(entry: entry, type: 'failure')
      FailureMailer.alert(entry).deliver_later
      SlackWebhook.post(entry) if ENV['SLACK_WEBHOOK']
    end
  end
end