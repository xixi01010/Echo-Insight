interface ProxyEnvironment {
  BACKEND_ORIGIN?: string;
}

interface PagesFunctionContext {
  request: Request;
  env: ProxyEnvironment;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const HOP_BY_HOP_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const RESPONSE_HEADERS_TO_RECALCULATE = ["content-encoding", "content-length"];

export async function onRequest(context: PagesFunctionContext): Promise<Response> {
  return proxyApiRequest(context.request, context.env);
}

export async function proxyApiRequest(
  request: Request,
  environment: ProxyEnvironment,
  fetcher: FetchLike = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const backendOrigin = readBackendOrigin(environment.BACKEND_ORIGIN);
  if (!backendOrigin) return proxyUnavailable();

  const requestUrl = new URL(request.url);
  if (requestUrl.pathname !== "/api" && !requestUrl.pathname.startsWith("/api/")) {
    return new Response("Not found.", { status: 404 });
  }

  const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, backendOrigin);
  const headers = copyRequestHeaders(request.headers);
  const init: RequestInit = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  try {
    const upstreamResponse = await fetcher(upstreamUrl, init);
    return copyUpstreamResponse(upstreamResponse);
  } catch {
    return proxyUnavailable();
  }
}

function readBackendOrigin(value: string | undefined): URL | undefined {
  if (!value) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return new URL(url.origin);
  } catch {
    return undefined;
  }
}

function copyRequestHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    if (!HOP_BY_HOP_REQUEST_HEADERS.has(name.toLowerCase())) {
      headers.set(name, value);
    }
  }
  return headers;
}

function copyUpstreamResponse(upstreamResponse: Response): Response {
  const headers = new Headers(upstreamResponse.headers);
  for (const header of RESPONSE_HEADERS_TO_RECALCULATE) headers.delete(header);

  const setCookies = readSetCookies(upstreamResponse.headers);
  if (setCookies.length > 0) {
    headers.delete("set-cookie");
    for (const cookie of setCookies) headers.append("set-cookie", cookie);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}

function readSetCookies(headers: Headers): string[] {
  const workerHeaders = headers as Headers & {
    getSetCookie?: () => string[];
    getAll?: (name: string) => string[];
  };
  if (typeof workerHeaders.getSetCookie === "function") return workerHeaders.getSetCookie();
  if (typeof workerHeaders.getAll === "function") return workerHeaders.getAll("set-cookie");

  const setCookie = headers.get("set-cookie");
  return setCookie ? [setCookie] : [];
}

function proxyUnavailable(): Response {
  return Response.json(
    { error: { code: "API_PROXY_UNAVAILABLE", message: "API is temporarily unavailable." } },
    { status: 503 },
  );
}
