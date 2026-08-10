import { quickRetry, acknowledgeAlert } from '../alerts/FailureAlertService';
export function FailureBanner({ entry }: { entry: any }) {
  return <div className="banner">Failed: {entry.status} <button onClick={() => quickRetry(entry.id)}>Quick Retry</button><button onClick={() => acknowledgeAlert(entry.id)}>Acknowledge</button></div>;
}