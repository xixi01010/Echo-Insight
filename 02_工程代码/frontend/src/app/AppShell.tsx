import { useEffect, useRef, useState, type FocusEvent, type PropsWithChildren } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { AppIcon, type AppIconName } from "../components/AppIcon";
import { BrandMark } from "../components/BrandMark";
import { useAuth } from "../features/auth/AuthContext";
import { useProjects } from "../features/projects/ProjectContext";

const navigationIcons: Record<string, AppIconName> = {
  "首页": "home",
  "项目": "projects",
  "AI 洞察": "insights",
  "设置": "settings",
};

export const SIDEBAR_EXPAND_DELAY_MS = 900;
export const SIDEBAR_COLLAPSE_DELAY_MS = 340;
const DESKTOP_HOVER_QUERY = "(hover: hover) and (pointer: fine) and (min-width: 769px)";

export function AppShell({ children }: PropsWithChildren) {
  const [desktopExpanded, setDesktopExpanded] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const expandTimerRef = useRef<number | null>(null);
  const collapseTimerRef = useRef<number | null>(null);
  const desktopHoverEnabledRef = useRef(false);
  const desktopExpandedRef = useRef(false);
  const pointerInsideRef = useRef(false);
  const focusInsideRef = useRef(false);
  const { logout, status } = useAuth();
  const { currentProject, projects } = useProjects();
  const location = useLocation();
  const projectId = currentProject?.id ?? projects[0]?.id;
  const projectDestination = projectId ? `/projects/${encodeURIComponent(projectId)}` : "/projects";
  const navigation = [
    { to: "/", label: "首页" },
    { to: projectDestination, label: "项目" },
    { to: "/insights", label: "AI 洞察" },
    { to: "/settings", label: "设置" },
  ];
  const user = status?.user;
  const displayName = user?.displayName?.trim() || "飞书用户";
  const contentWidth = location.pathname.startsWith("/projects/")
    ? "wide"
    : location.pathname === "/settings" ? "settings" : "standard";

  const clearExpandTimer = () => {
    if (expandTimerRef.current !== null) {
      window.clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
  };

  const clearCollapseTimer = () => {
    if (collapseTimerRef.current !== null) {
      window.clearTimeout(collapseTimerRef.current);
      collapseTimerRef.current = null;
    }
  };

  const scheduleCollapse = () => {
    if (collapseTimerRef.current !== null || !desktopExpandedRef.current) return;
    clearCollapseTimer();
    collapseTimerRef.current = window.setTimeout(() => {
      collapseTimerRef.current = null;
      if (pointerInsideRef.current || focusInsideRef.current) return;
      desktopExpandedRef.current = false;
      setDesktopExpanded(false);
    }, SIDEBAR_COLLAPSE_DELAY_MS);
  };

  const collapseDesktopSidebar = () => {
    desktopExpandedRef.current = false;
    setDesktopExpanded(false);
  };

  useEffect(() => {
    const media = window.matchMedia(DESKTOP_HOVER_QUERY);
    const applyDesktopHoverCapability = () => {
      desktopHoverEnabledRef.current = media.matches;
      if (!media.matches) {
        clearExpandTimer();
        clearCollapseTimer();
        pointerInsideRef.current = false;
        focusInsideRef.current = false;
        collapseDesktopSidebar();
      }
    };

    applyDesktopHoverCapability();
    media.addEventListener("change", applyDesktopHoverCapability);
    return () => {
      media.removeEventListener("change", applyDesktopHoverCapability);
      clearExpandTimer();
      clearCollapseTimer();
    };
  }, []);

  const handleSidebarPointerEnter = () => {
    if (!desktopHoverEnabledRef.current) return;
    pointerInsideRef.current = true;
    clearCollapseTimer();
    if (desktopExpandedRef.current || expandTimerRef.current !== null) return;
    expandTimerRef.current = window.setTimeout(() => {
      expandTimerRef.current = null;
      if (!pointerInsideRef.current) return;
      desktopExpandedRef.current = true;
      setDesktopExpanded(true);
    }, SIDEBAR_EXPAND_DELAY_MS);
  };

  const handleSidebarPointerLeave = () => {
    if (!desktopHoverEnabledRef.current) return;
    pointerInsideRef.current = false;
    clearExpandTimer();
    if (focusInsideRef.current || sidebarRef.current?.contains(document.activeElement)) return;
    scheduleCollapse();
  };

  const handleSidebarFocus = () => {
    if (!desktopHoverEnabledRef.current) return;
    focusInsideRef.current = true;
    clearCollapseTimer();
    if (pointerInsideRef.current && !desktopExpandedRef.current) return;
    clearExpandTimer();
    desktopExpandedRef.current = true;
    setDesktopExpanded(true);
  };

  const handleSidebarBlur = (event: FocusEvent<HTMLElement>) => {
    if (!desktopHoverEnabledRef.current) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    focusInsideRef.current = false;
    scheduleCollapse();
  };

  const closeNavigation = () => {
    clearExpandTimer();
    clearCollapseTimer();
    pointerInsideRef.current = false;
    focusInsideRef.current = false;
    collapseDesktopSidebar();
    setMobileOpen(false);
  };

  return (
    <div className="workspace-shell">
      {mobileOpen ? <button aria-label="收起导航" className="workspace-mobile-overlay" onClick={closeNavigation} type="button" /> : null}
      <aside
        className={`workspace-sidebar ${desktopExpanded ? "is-expanded" : ""} ${mobileOpen ? "is-mobile-open" : ""}`}
        data-desktop-state={desktopExpanded ? "expanded" : "collapsed"}
        onBlurCapture={handleSidebarBlur}
        onFocusCapture={handleSidebarFocus}
        onPointerEnter={handleSidebarPointerEnter}
        onPointerLeave={handleSidebarPointerLeave}
        ref={sidebarRef}
      >
        <div className="workspace-sidebar__brand">
          <BrandMark appIconVariant size={36} />
          <div className="workspace-sidebar__brand-copy"><strong>回响</strong><span>Echo Insight</span></div>
          <button aria-label="关闭导航" className="icon-button workspace-sidebar__mobile-close" onClick={() => setMobileOpen(false)} type="button"><AppIcon name="close" /></button>
        </div>

        <nav className="workspace-navigation" aria-label="主要导航">
          {navigation.map((item) => {
            const active = item.label === "项目"
              ? location.pathname.startsWith("/projects")
              : item.to === "/" ? location.pathname === "/" : location.pathname === item.to;
            return (
              <NavLink
                aria-current={active ? "page" : undefined}
                className={`workspace-navigation__item ${active ? "is-active" : ""}`}
                key={item.label}
                onClick={() => setMobileOpen(false)}
                title={!desktopExpanded ? item.label : undefined}
                to={item.to}
              >
                <AppIcon name={navigationIcons[item.label] ?? "home"} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        <div className="workspace-sidebar__footer">
          <div className="workspace-sidebar__account">
            <div className="user-avatar" aria-hidden="true">{user?.avatarUrl ? <img alt="" src={user.avatarUrl} /> : displayName.slice(0, 1)}</div>
            <div className="workspace-sidebar__account-copy"><strong>{displayName}</strong><span>已通过飞书登录</span></div>
            <button aria-label="退出登录" className="icon-button workspace-sidebar__logout" onClick={() => void logout()} title="退出登录" type="button"><AppIcon name="logout" /></button>
          </div>
        </div>
      </aside>

      <div className="workspace-main">
        <header className="workspace-mobile-header">
          <button aria-label="打开导航" className="icon-button" onClick={() => setMobileOpen(true)} type="button"><AppIcon name="menu" /></button>
          <div className="workspace-mobile-header__brand"><BrandMark appIconVariant size={30} /><strong>Echo Insight</strong></div>
          <div className="user-avatar user-avatar--small" aria-label={displayName}>{displayName.slice(0, 1)}</div>
        </header>
        <div className="workspace-viewport">
          <main className={`workspace-content workspace-content--${contentWidth}`}>{children}</main>
        </div>
      </div>
    </div>
  );
}
