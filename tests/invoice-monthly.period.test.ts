import test from "node:test";
import assert from "node:assert/strict";
import {
  buildIncomingQuery,
  buildSentQuery,
  computePreviousCalendarMonth,
  formatInternalDateToLocalDate,
  isInternalDateInPeriod,
  periodFromString,
} from "../src/invoice-monthly/period.js";

test("previous-month calculation across year boundaries", () => {
  const period = computePreviousCalendarMonth(new Date("2027-01-15T08:00:00Z"), "Europe/Bratislava");
  assert.equal(period.period, "2026-12");
  assert.equal(period.startDate, "2026-12-01");
  assert.equal(period.endExclusiveDate, "2027-01-01");
});

test("leap-year February period boundaries", () => {
  const period = periodFromString("2024-02", "Europe/Bratislava");
  assert.equal(period.startDate, "2024-02-01");
  assert.equal(period.endExclusiveDate, "2024-03-01");
});

test("Europe/Bratislava date handling uses local month", () => {
  const period = periodFromString("2026-06", "Europe/Bratislava");
  const inside = new Date("2026-06-30T21:59:59.000Z").getTime();
  const outside = new Date("2026-06-30T22:00:00.000Z").getTime();
  assert.equal(isInternalDateInPeriod(inside, period), true);
  assert.equal(isInternalDateInPeriod(outside, period), false);
});

test("exact Gmail internalDate boundary filtering", () => {
  const period = periodFromString("2026-06", "Europe/Bratislava");
  const atStart = new Date("2026-05-31T22:00:00.000Z").getTime();
  const beforeStart = new Date("2026-05-31T21:59:59.000Z").getTime();
  assert.equal(isInternalDateInPeriod(atStart, period), true);
  assert.equal(isInternalDateInPeriod(beforeStart, period), false);
});

test("formatInternalDateToLocalDate returns Bratislava local date", () => {
  const formatted = formatInternalDateToLocalDate(new Date("2026-06-15T10:30:00.000Z").getTime(), "Europe/Bratislava");
  assert.equal(formatted.localDate, "2026-06-15");
  assert.match(formatted.timestampIso, /^2026-06-15T10:30:00.000Z$/);
});

test("incoming Gmail query includes read-only incoming constraints", () => {
  const query = buildIncomingQuery(periodFromString("2026-06", "Europe/Bratislava"));
  assert.equal(query, "after:2026/06/01 before:2026/07/01 has:attachment filename:pdf -in:sent -in:spam -in:trash");
});

test("sent Gmail query includes Sent Mail constraint", () => {
  const query = buildSentQuery(periodFromString("2026-06", "Europe/Bratislava"));
  assert.equal(query, "in:sent after:2026/06/01 before:2026/07/01 has:attachment filename:pdf -in:spam -in:trash");
});
