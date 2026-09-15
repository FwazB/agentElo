export function completedWeekWindow(now: Date = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid date.");
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7) - 7);
  const end = new Date(start.getTime() + 604_800_000);
  const thursday = new Date(start.getTime() + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const january4 = new Date(Date.UTC(year, 0, 4));
  const firstThursday = new Date(january4);
  firstThursday.setUTCDate(january4.getUTCDate() + 3 - ((january4.getUTCDay() + 6) % 7));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / 604_800_000);
  return { weekId: `${year}-W${String(week).padStart(2, "0")}`, start: start.toISOString(), end: end.toISOString() };
}

export const lastCompletedWeek = (now: Date = new Date()) => completedWeekWindow(now).weekId;
