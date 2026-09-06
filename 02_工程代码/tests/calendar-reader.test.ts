import assert from "node:assert/strict";
import test from "node:test";
import type { EffectiveFact } from "../backend/src/intelligence/evidence/index.js";
import { toFeishuOpenIdIdentityRef } from "../backend/src/current-user/index.js";
import { FeishuCalendarReader, SourceReadError, type ProjectSourceReadContext } from "../feishu-connector/src/index.js";

test("reads only explicit event IDs in one calendar and preserves recurrence position", async () => {
  const calls: unknown[] = [];
  const reader = new FeishuCalendarReader({ calendar: { v4: { calendarEvent: {
    get: async (request) => { calls.push(request); return { code: 0, data: { event: { event_id: request.path.event_id, summary: "例会", description: "原始日程", start_time: { timestamp: "100", timezone: "UTC" }, end_time: { timestamp: "200", timezone: "UTC" }, event_organizer: { user_id: "owner" }, attendees: [{ attendee_id: "member", type: "user" }], recurring_event_id: "series-1" } } }; },
  } } } }, options());
  const result = await reader.read({ context: context(), locator: { calendarId: "cal-1", eventIds: ["event-1", "event-1"], syncToken: "cursor-1" } });
  assert.equal(result.status, "success"); if (result.status !== "success") throw new Error("Expected success.");
  assert.deepEqual(calls, [{ path: { calendar_id: "cal-1", event_id: "event-1" }, params: { need_attendee: true, user_id_type: "open_id" } }]);
  assert.equal(result.data.events[0]?.organizer?.value, "owner"); assert.equal(result.data.events[0]?.recurringEventId, "series-1"); assert.deepEqual(result.data.syncToken, { state: "positioned" });
  // @ts-expect-error Calendar contents remain observations rather than admitted Facts.
  const _notFact: EffectiveFact<unknown> = result.data; void _notFact;
});
test("visibility blocks calendar reads without scanning calendars or events", async () => {
  let calls = 0;
  const reader = new FeishuCalendarReader({ calendar: { v4: { calendarEvent: { get: async () => { calls += 1; return { code: 0 }; } } } } }, options());
  assert.equal((await reader.read({ context: context("denied"), locator: { calendarId: "cal-1", eventIds: ["event-1"] } })).status, "unavailable"); assert.equal(calls, 0);
});
test("Calendar maps FND-04 errors and hides raw credential text", async () => {
  for (const error of [new SourceReadError("not-found"), new SourceReadError("rate-limited"), new Error("calendar-token-secret")]) {
    const reader = new FeishuCalendarReader({ calendar: { v4: { calendarEvent: { get: async () => { throw error; } } } } }, options()); const result = await reader.read({ context: context(), locator: { calendarId: "cal-1", eventIds: ["event-1"] } });
    assert.equal(result.status, "failure"); assert.equal(JSON.stringify(result).includes("calendar-token-secret"), false);
  }
});
function options() { return { identityContext: { applicationId: "cli_echo" } }; }
function context(visibility: ProjectSourceReadContext["visibility"] = "allowed"): ProjectSourceReadContext { return { projectId: "project-1", sourceRef: "source-calendar", sourceKind: "feishu-calendar", subject: { userId: "user-1", identity: toFeishuOpenIdIdentityRef("viewer", "cli_echo") }, authorization: visibility === "allowed" ? { sourceAuthorization: "authorized", subjectEligibility: "allowed" } : { sourceAuthorization: "unknown", subjectEligibility: "unknown" }, visibility }; }
