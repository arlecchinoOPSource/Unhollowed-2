export interface CalendarSettings {
  /** First day of the week: 0 Sunday to 6 Saturday. */
  weekStart: number;
  /** Days shown by Workweek and treated as working days: 0 Sunday to 6. */
  workDays: number[];
  /** Working hours, `HH:MM`, end exclusive. */
  workStart: string;
  workEnd: string;
  /** Minutes between grid lines. */
  increment: 15 | 30 | 60;
}

export const defaultSettings: CalendarSettings = {
  weekStart: 1,
  workDays: [1, 2, 3, 4, 5],
  workStart: "09:00",
  workEnd: "17:00",
  increment: 30,
};

export const increments = [15, 30, 60] as const;
