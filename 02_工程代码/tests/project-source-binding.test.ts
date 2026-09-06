import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FixedCurrentUserContextProvider } from "../backend/src/current-user/index.js";
import { createEchoInsightServer } from "../backend/src/index.js";
import { JsonProjectDataSourceRegistry, ProjectSourceBindingService, ProjectSourceConfigurationService } from "../backend/src/project-context/index.js";
import { JsonProjectRepository, ProjectService } from "../backend/src/project-service/index.js";
import type { FeishuApiClient } from "../feishu-connector/src/index.js";

test("Calendar source binding uses short-lived opaque selections and never accepts a browser locator", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "echo-binding-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const projectService = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")));
  const project = await projectService.createProject({ name: "UAT", creatorId: "owner", ownerId: "owner" });
  const registry = new JsonProjectDataSourceRegistry(join(directory, "sources.json"));
  const sourceService = new ProjectSourceConfigurationService(projectService, registry);
  const client = calendarClient();
  const binding = new ProjectSourceBindingService(projectService, { getUserAccessToken: async () => "test-token" }, () => client, () => Date.parse("2026-09-02T00:00:00.000Z"), (() => { let id = 0; return () => `opaque-${++id}`; })());
  const server = createEchoInsightServer({
    currentUserContextProvider: new FixedCurrentUserContextProvider("owner"),
    projectService,
    projectSourceConfigurationService: sourceService,
    projectSourceBindingService: binding,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;

  const calendars = await fetch(`${origin}/api/projects/${project.id}/sources/options/calendar`);
  const calendarBody = await calendars.json() as { items: Array<{ id: string; label: string }> };
  assert.equal(calendars.status, 200);
  assert.equal(calendarBody.items.length, 1);
  assert.equal(JSON.stringify(calendarBody).includes("calendar-private"), false);
  const calendarSelection = calendarBody.items[0]?.id; assert.ok(calendarSelection);

  const events = await fetch(`${origin}/api/projects/${project.id}/sources/options/calendar/${calendarSelection}/events?start=2026-09-01T00%3A00%3A00.000Z&end=2026-09-10T00%3A00%3A00.000Z`);
  const eventBody = await events.json() as { items: Array<{ id: string; title: string }> };
  assert.equal(events.status, 200);
  assert.equal(eventBody.items[0]?.title, "项目评审");
  assert.equal(JSON.stringify(eventBody).includes("event-private"), false);
  const eventSelection = eventBody.items[0]?.id; assert.ok(eventSelection);

  const bound = await fetch(`${origin}/api/projects/${project.id}/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "项目评审", selectionId: eventSelection }) });
  assert.equal(bound.status, 201);
  const publicText = await (await fetch(`${origin}/api/projects/${project.id}/sources`)).text();
  for (const secret of ["calendar-private", "event-private", "locator", "credential", "test-token"]) assert.equal(publicText.includes(secret), false);

  const rawLocator = await fetch(`${origin}/api/projects/${project.id}/sources`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locator: { kind: "feishu-calendar", calendarId: "calendar-private", eventIds: ["event-private"] } }) });
  assert.equal(rawLocator.status, 400);
});

test("Calendar selections are project and user scoped", async () => {
  const directory = await mkdtemp(join(tmpdir(), "echo-binding-scope-"));
  try {
    const service = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")));
    const project = await service.createProject({ name: "Scoped", creatorId: "owner", ownerId: "owner", members: ["member"] });
    const binding = new ProjectSourceBindingService(service, { getUserAccessToken: async () => "test-token" }, calendarClient);
    const calendars = await binding.listCalendars(project.id, { userId: "owner", source: "development-fixed" });
    const id = calendars.items[0]?.id; assert.ok(id);
    await assert.rejects(binding.listCalendarEvents(project.id, { userId: "member", source: "development-fixed" }, id), /access denied|forbidden/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Calendar binding accepts the SDK nested calendar entry shape without exposing its locator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "echo-binding-nested-calendar-"));
  try {
    const service = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")));
    const project = await service.createProject({ name: "Nested calendar", creatorId: "owner", ownerId: "owner" });
    const client = calendarClient();
    client.calendar!.v4!.calendar!.list = async () => ({ code: 0, data: { calendar_list: [{ calendar: { calendar_id: "nested-private", is_primary: true } }], has_more: false } }) as never;
    const binding = new ProjectSourceBindingService(service, { getUserAccessToken: async () => "test-token" }, () => client);
    const result = await binding.listCalendars(project.id, { userId: "owner", source: "development-fixed" });
    assert.deepEqual(result.items.map((item) => item.label), ["主日历"]);
    assert.equal(JSON.stringify(result).includes("nested-private"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Calendar binding accepts a single calendar-list entry returned as an object", async () => {
  const directory = await mkdtemp(join(tmpdir(), "echo-binding-single-calendar-"));
  try {
    const service = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")));
    const project = await service.createProject({ name: "Single calendar", creatorId: "owner", ownerId: "owner" });
    const client = calendarClient();
    client.calendar!.v4!.calendar!.list = async () => ({ code: 0, data: { calendar_list: { calendar_id: "single-private", type: "primary" }, has_more: false } }) as never;
    const binding = new ProjectSourceBindingService(service, { getUserAccessToken: async () => "test-token" }, () => client);
    const result = await binding.listCalendars(project.id, { userId: "owner", source: "development-fixed" });
    assert.equal(result.items.length, 1);
    assert.equal(JSON.stringify(result).includes("single-private"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Calendar binding falls back to the current user's primary calendar when the bounded list is empty", async () => {
  const directory = await mkdtemp(join(tmpdir(), "echo-binding-primary-calendar-"));
  try {
    const service = new ProjectService(new JsonProjectRepository(join(directory, "projects.json")));
    const project = await service.createProject({ name: "Primary calendar", creatorId: "owner", ownerId: "owner" });
    const client = calendarClient();
    client.calendar!.v4!.calendar!.list = async () => ({ code: 0, data: { calendar_list: [], has_more: false } }) as never;
    client.calendar!.v4!.calendar!.primary = async () => ({ code: 0, data: { calendars: [{ calendar: { calendar_id: "primary-private", is_primary: true } }] } }) as never;
    const binding = new ProjectSourceBindingService(service, { getUserAccessToken: async () => "test-token" }, () => client);
    const result = await binding.listCalendars(project.id, { userId: "owner", source: "development-fixed" });
    assert.deepEqual(result.items.map((item) => item.label), ["主日历"]);
    assert.equal(JSON.stringify(result).includes("primary-private"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function calendarClient(): FeishuApiClient {
  return {
    calendar: { v4: {
      calendar: { list: async () => ({ code: 0, data: { calendar_list: [{ calendar_id: "calendar-private", is_primary: true }], has_more: false } }) },
      calendarEvent: {
        get: async () => ({ code: 0, data: {} }),
        list: async () => ({ code: 0, data: { items: [{ event_id: "event-private", summary: "项目评审", start_time: { timestamp: "1788511200" }, end_time: { timestamp: "1788514800" } }], has_more: false } }),
      },
    } },
  } as unknown as FeishuApiClient;
}
