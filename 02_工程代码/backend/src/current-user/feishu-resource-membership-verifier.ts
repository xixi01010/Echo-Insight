export interface FeishuResourceMembershipVerifier {
  verifyBaseViewAccess(userAccessToken: string, baseToken: string): Promise<boolean>;
}

/**
 * Verifies the authenticated user's own access to one Base. This never lists
 * collaborators and never accepts a tenant token configuration.
 */
export class HttpFeishuResourceMembershipVerifier implements FeishuResourceMembershipVerifier {
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}

  async verifyBaseViewAccess(userAccessToken: string, baseToken: string): Promise<boolean> {
    const token = userAccessToken.trim();
    const resource = baseToken.trim();
    if (!token || !resource) return false;

    try {
      const url = new URL(
        `https://open.feishu.cn/open-apis/drive/v1/permissions/${encodeURIComponent(resource)}/members/auth`,
      );
      url.searchParams.set("type", "bitable");
      url.searchParams.set("action", "view");
      const response = await this.fetcher(url, {
        headers: { authorization: `Bearer ${token}` },
      });
      const payload: unknown = await response.json().catch(() => undefined);
      return response.ok && isVerifiedPermissionResponse(payload);
    } catch {
      return false;
    }
  }
}

function isVerifiedPermissionResponse(value: unknown): boolean {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { code?: unknown }).code === 0
    && typeof (value as { data?: unknown }).data === "object"
    && (value as { data: { auth_result?: unknown } }).data.auth_result === true;
}
