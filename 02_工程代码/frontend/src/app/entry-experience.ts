export type ApplicationEntryExperience = "loading" | "choice" | "demo" | "workspace";

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
  if (new URLSearchParams(search).get("mode") === "demo") return "choice";
  if (pathname === "/demo") return "demo";
  if (loading) return "loading";
  return authenticated ? "workspace" : "demo";
}

export function removeDemoModeFromSearch(search: string): string {
  const searchParams = new URLSearchParams(search);
  searchParams.delete("mode");
  const nextSearch = searchParams.toString();
  return nextSearch ? `?${nextSearch}` : "";
}
