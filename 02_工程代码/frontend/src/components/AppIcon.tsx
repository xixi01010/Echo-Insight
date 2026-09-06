import type { SVGProps } from "react";

export type AppIconName = "home" | "projects" | "insights" | "settings" | "menu" | "close" | "logout" | "plus" | "join" | "chevron" | "star";

export function AppIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: AppIconName }) {
  const paths: Record<AppIconName, React.ReactNode> = {
    home: <><path d="M3 10.8 12 3l9 7.8"/><path d="M5.5 9.5V21h13V9.5M9.5 21v-6h5v6"/></>,
    projects: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M8 4V2m8 2V2M7 9h10M7 13h4m-4 4h7"/></>,
    insights: <><path d="M12 3a7 7 0 0 0-4 12.75V19h8v-3.25A7 7 0 0 0 12 3Z"/><path d="M9 22h6m-5-7h4m-2-9v3"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21h-4v-.1A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3v-4h.1A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3h4v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.15.38.36.72.66 1 .3.26.68.4 1.08.4H21v4h-.1a1.7 1.7 0 0 0-1.5.6Z"/></>,
    menu: <path d="M4 7h16M4 12h16M4 17h16"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    logout: <><path d="M10 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5"/><path d="m16 16 4-4-4-4m4 4H9"/></>,
    plus: <path d="M12 5v14M5 12h14"/>,
    join: <><path d="M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="m9 8-4 4 4 4m-4-4h11"/></>,
    chevron: <path d="m9 18 6-6-6-6"/>,
    star: <path d="m12 3 2.7 5.47 6.04.88-4.37 4.26 1.03 6.02L12 16.8l-5.4 2.83 1.03-6.02-4.37-4.26 6.04-.88L12 3Z"/>,
  };
  return (
    <svg aria-hidden="true" fill="none" height="24" viewBox="0 0 24 24" width="24" {...props}>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">{paths[name]}</g>
    </svg>
  );
}
