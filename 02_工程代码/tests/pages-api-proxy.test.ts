import assert from "node:assert/strict";
import test from "node:test";

import { proxyApiRequest } from "../functions/api/[[path]].js";

const environment = {
  BACKEND_ORIGIN: "https://echo-insight-production.up.railway.app",
};

test("Pages API proxy preserves the API path, query, request body, and browser session headers", async () => {
  let upstreamUrl = "";
  let upstreamMethod = "";
  let upstreamHeaders: Headers | undefined;
  let upstreamBody = "";
  let redirectMode: RequestRedirect | undefined;
  const response = await proxyApiRequest(
    new Request("https://echo-insight.pages.dev/api/projects?view=mine", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: "echo_insight_session=session-id",
        origin: "https://echo-insight.pages.dev",
      },
      body: JSON.stringify({ name: "【演示】品牌焕新计划" }),
    }),
    environment,
    async (input, init) => {
      upstreamUrl = String(input);
      upstreamMethod = init?.method ?? "GET";
      upstreamHeaders = new Headers(init?.headers);
      upstreamBody = init?.body ? await new Response(init.body).text() : "";
      redirectMode = init?.redirect;
      return new Response(JSON.stringify({ id: "project-a" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  );

  assert.equal(upstreamUrl, "https://echo-insight-production.up.railway.app/api/projects?view=mine");
  assert.equal(upstreamMethod, "POST");
  assert.equal(upstreamHeaders?.get("content-type"), "application/json");
  assert.equal(upstreamHeaders?.get("cookie"), "echo_insight_session=session-id");
  assert.equal(upstreamHeaders?.get("origin"), "https://echo-insight.pages.dev");
  assert.equal(upstreamBody, '{"name":"【演示】品牌焕新计划"}');
  assert.equal(redirectMode, "manual");
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "application/json");
});

test("Pages API proxy preserves OAuth callback redirects and session cookies", async () => {
  let upstreamUrl = "";
  let upstreamCookie = "";
  const response = await proxyApiRequest(
    new Request("https://echo-insight.pages.dev/api/auth/feishu/callback?code=temporary&state=state-id", {
      headers: { cookie: "echo_insight_oauth_state=state-id" },
    }),
    environment,
    async (input, init) => {
      upstreamUrl = String(input);
      upstreamCookie = new Headers(init?.headers).get("cookie") ?? "";
      const headers = new Headers({ location: "https://echo-insight.pages.dev/" });
      headers.append("set-cookie", "echo_insight_session=session-id; Path=/; HttpOnly; Secure; SameSite=Lax");
      headers.append("set-cookie", "echo_insight_oauth_state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0");
      return new Response(null, { status: 302, headers });
    },
  );

  assert.equal(upstreamUrl, "https://echo-insight-production.up.railway.app/api/auth/feishu/callback?code=temporary&state=state-id");
  assert.equal(upstreamCookie, "echo_insight_oauth_state=state-id");
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://echo-insight.pages.dev/");
  const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
  assert.equal(cookies.length, 2);
  assert.match(cookies[0] ?? "", /echo_insight_session=session-id/);
  assert.match(cookies[0] ?? "", /HttpOnly/);
  assert.match(cookies[0] ?? "", /SameSite=Lax/);
  assert.match(cookies[1] ?? "", /echo_insight_oauth_state=/);
});

test("Pages API proxy fails closed when the server-side backend origin is unavailable or unsafe", async () => {
  let calls = 0;
  const fetcher = async (): Promise<Response> => {
    calls += 1;
    return new Response();
  };

  const missingOrigin = await proxyApiRequest(
    new Request("https://echo-insight.pages.dev/api/projects"),
    {},
    fetcher,
  );
  const unsafeOrigin = await proxyApiRequest(
    new Request("https://echo-insight.pages.dev/api/projects"),
    { BACKEND_ORIGIN: "http://127.0.0.1:3000" },
    fetcher,
  );

  assert.equal(missingOrigin.status, 503);
  assert.equal(unsafeOrigin.status, 503);
  assert.equal(calls, 0);
  assert.deepEqual(await missingOrigin.json(), {
    error: { code: "API_PROXY_UNAVAILABLE", message: "API is temporarily unavailable." },
  });
});

test("Pages API proxy does not expose its fixed backend origin through invalid paths", async () => {
  let calls = 0;
  const response = await proxyApiRequest(
    new Request("https://echo-insight.pages.dev/not-api"),
    environment,
    async () => {
      calls += 1;
      return new Response();
    },
  );

  assert.equal(response.status, 404);
  assert.equal(calls, 0);
});
