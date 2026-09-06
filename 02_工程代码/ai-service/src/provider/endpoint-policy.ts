const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";

interface OfficialEndpointPolicy {
  providerName: string;
  variableName: string;
  isAllowedHostname: (hostname: string) => boolean;
  allowBaseUrl?: boolean;
}

export function normalizeOfficialChatCompletionsUrl(
  value: string,
  policy: OfficialEndpointPolicy,
): string {
  const url = parseEndpoint(value, policy.variableName);
  if (url.protocol !== "https:") {
    throw new Error(`${policy.variableName} must use HTTPS for ${policy.providerName}.`);
  }
  if (url.port || !policy.isAllowedHostname(url.hostname.toLowerCase())) {
    throw new Error(`${policy.variableName} must use an official ${policy.providerName} host.`);
  }
  return normalizeChatCompletionsPath(url, policy.variableName, policy.allowBaseUrl);
}

export function normalizeCustomChatCompletionsUrl(
  value: string,
  variableName: string,
  options: { allowBaseUrl?: boolean } = {},
): string {
  const url = parseEndpoint(value, variableName);
  const hostname = url.hostname.toLowerCase();
  const allowedLocalHttp = url.protocol === "http:" && isLocalHostname(hostname);
  if (url.protocol !== "https:" && !allowedLocalHttp) {
    throw new Error(`${variableName} must use HTTPS, except for localhost HTTP.`);
  }
  return normalizeChatCompletionsPath(url, variableName, options.allowBaseUrl);
}

export function isOfficialDeepSeekHostname(hostname: string): boolean {
  return hostname === "api.deepseek.com";
}

export function isOfficialDashScopeHostname(hostname: string): boolean {
  return hostname === "dashscope.aliyuncs.com"
    || hostname === "dashscope-intl.aliyuncs.com"
    || hostname === "dashscope-us.aliyuncs.com"
    || hostname === "cn-hongkong.dashscope.aliyuncs.com"
    || hostname.endsWith(".maas.aliyuncs.com");
}

function parseEndpoint(value: string, variableName: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid absolute URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${variableName} must not contain URL credentials.`);
  }
  if (value.includes("?") || value.includes("#") || url.search || url.hash) {
    throw new Error(`${variableName} must not contain query parameters or a URL fragment.`);
  }
  return url;
}

function normalizeChatCompletionsPath(
  url: URL,
  variableName: string,
  allowBaseUrl = false,
): string {
  const path = url.pathname.replace(/\/+$/u, "");
  if (!path.endsWith(CHAT_COMPLETIONS_SUFFIX) && !allowBaseUrl) {
    throw new Error(`${variableName} must be a complete /chat/completions URL.`);
  }
  url.pathname = path.endsWith(CHAT_COMPLETIONS_SUFFIX)
    ? path
    : `${path}${CHAT_COMPLETIONS_SUFFIX}`;
  return url.toString();
}

function isLocalHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "[::1]";
}
