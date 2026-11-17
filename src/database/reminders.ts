import { invoke } from "@tauri-apps/api/core";

export interface DueReminder {
  eventId: string;
  title: string;
  /** The start being reminded, as a UTC instant. */
  startAt: string;
  minutesBefore: number;
}

export interface ReminderRun {
  delivered: DueReminder[];
  /** Reminders the system would not show. They are not retried. */
  failed: number;
}

export function getRemindersEnabled(): Promise<boolean> {
  return invoke("get_reminders_enabled");
}

export function setRemindersEnabled(enabled: boolean): Promise<boolean> {
  return invoke("set_reminders_enabled", { enabled });
}

export function getEventReminder(eventId: string): Promise<number | null> {
  return invoke("get_event_reminder", { eventId });
}

export function setEventReminder(
  eventId: string,
  minutesBefore: number | null,
): Promise<number | null> {
  return invoke("set_event_reminder", { eventId, minutesBefore });
}

export function claimDueReminders(): Promise<ReminderRun> {
  return invoke("claim_due_reminders");
}

export function sendTestNotification(): Promise<void> {
  return invoke("send_test_notification");
}

/** Offsets the editor offers, in minutes before the start. */
export const reminderOffsets: [number, string][] = [
  [0, "At the start"],
  [5, "5 minutes before"],
  [10, "10 minutes before"],
  [15, "15 minutes before"],
  [30, "30 minutes before"],
  [60, "1 hour before"],
  [1440, "1 day before"],
];
