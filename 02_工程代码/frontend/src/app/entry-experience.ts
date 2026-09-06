export type ApplicationEntryExperience = "loading" | "demo" | "workspace";

export function resolveApplicationEntryExperience({
  authenticated,
  loading,
  pathname,
  search,
}: {
  authenticated: boolean;
  loading: boolean;
  pathname: string;
  search: string;
}): ApplicationEntryExperience {
  const requestedDemo = pathname === "/demo"
    || new URLSearchParams(search).get("mode") === "demo";
  if (requestedDemo) return "demo";
  if (loading) return "loading";
  return authenticated ? "workspace" : "demo";
}
