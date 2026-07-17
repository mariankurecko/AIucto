import { PeriodInfo } from "./types.js";

function formatterParts(date: Date, timeZone: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return Object.fromEntries(
    formatter.formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function previousMonth(year: number, month: number): { year: number; month: number } {
  if (month === 1) {
    return { year: year - 1, month: 12 };
  }
  return { year, month: month - 1 };
}

export function computePreviousCalendarMonth(
  now: Date,
  timeZone: string,
): PeriodInfo {
  const localNow = formatterParts(now, timeZone);
  const currentYear = Number.parseInt(localNow.year, 10);
  const currentMonth = Number.parseInt(localNow.month, 10);
  return periodFromYearMonth(...Object.values(previousMonth(currentYear, currentMonth)).map(Number) as [number, number], timeZone);
}

export function periodFromString(period: string, timeZone: string): PeriodInfo {
  const match = period.match(/^(\d{4})-(\d{2})$/);
  if (!match) {
    throw new Error(`Invalid period '${period}'. Expected YYYY-MM.`);
  }
  return periodFromYearMonth(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    timeZone,
  );
}

export function periodFromYearMonth(
  year: number,
  month: number,
  timeZone: string,
): PeriodInfo {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error(`Invalid year/month '${year}-${month}'.`);
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const startDate = `${year}-${pad(month)}-01`;
  const endExclusiveDate = `${nextYear}-${pad(nextMonth)}-01`;
  return {
    period: `${year}-${pad(month)}`,
    year,
    month,
    startDate,
    endExclusiveDate,
    queryAfter: startDate.replace(/-/g, "/"),
    queryBefore: endExclusiveDate.replace(/-/g, "/"),
    timezone: timeZone,
  };
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function dateBelongsToPeriod(date: string | null | undefined, period: PeriodInfo): boolean {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date >= period.startDate && date < period.endExclusiveDate;
}

export function periodStringFromDate(date: string | null | undefined): string | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date.slice(0, 7);
}

export function formatInternalDateToLocalDate(
  internalDateMs: number,
  timeZone: string,
): { localDate: string; timestampIso: string } {
  const date = new Date(internalDateMs);
  const parts = formatterParts(date, timeZone);
  return {
    localDate: `${parts.year}-${parts.month}-${parts.day}`,
    timestampIso: date.toISOString(),
  };
}

export function isInternalDateInPeriod(
  internalDateMs: number,
  period: PeriodInfo,
): boolean {
  const { localDate } = formatInternalDateToLocalDate(internalDateMs, period.timezone);
  return localDate >= period.startDate && localDate < period.endExclusiveDate;
}

export function buildIncomingQuery(period: PeriodInfo, nextMonthScanDays = 15): string {
  const scanBefore = addDays(period.endExclusiveDate, nextMonthScanDays);
  return [
    `after:${period.queryAfter}`,
    `before:${scanBefore.replace(/-/g, "/")}`,
    "has:attachment",
    "filename:pdf",
    "-in:sent",
    "-in:spam",
    "-in:trash",
  ].join(" ");
}

export function buildSentQuery(period: PeriodInfo, nextMonthScanDays = 15): string {
  const scanBefore = addDays(period.endExclusiveDate, nextMonthScanDays);
  return [
    "in:sent",
    `after:${period.queryAfter}`,
    `before:${scanBefore.replace(/-/g, "/")}`,
    "has:attachment",
    "filename:pdf",
    "-in:spam",
    "-in:trash",
  ].join(" ");
}
