import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { AppShell } from "./AppShell";
import { animatePageEnter } from "../animations/page-transition";
import { animateHighRiskEmphasis } from "../animations/risk-emphasis";
import { RiskCenterPage } from "../pages/RiskCenter/RiskCenterPage";
import { AIReportPage } from "../pages/AIReport/AIReportPage";
import { SettingsPage } from "../pages/Settings/SettingsPage";
import { useProjectReport } from "../features/project-report/useProjectReport";
import { ProjectProvider } from "../features/projects/ProjectContext";
import { useProjects } from "../features/projects/ProjectContext";
import { PreferenceProvider } from "../features/preferences/PreferenceContext";
import { ProjectsPage } from "../pages/Projects/ProjectsPage";
import { CreateProjectPage } from "../pages/Projects/CreateProjectPage";
import { ProjectSpacePage } from "../pages/Project/ProjectSpacePage";
import { InsightsPage } from "../pages/Insights/InsightsPage";
import { AuthProvider, useAuth } from "../features/auth/AuthContext";
import { AiAccessProvider } from "../features/ai-access/AiAccessContext";
import { useAiAccess } from "../features/ai-access/AiAccessContext";
import { AiSetupBoundary } from "../features/ai-access/AiSetupBoundary";
import { advanceClientCacheEpoch } from "../features/ai-access/client-cache-epoch";
import { useDelayedLoadingVisibility } from "../hooks/useDelayedLoadingVisibility";
import { WorkspacePreview } from "./WorkspacePreview";
import { resolveApplicationEntryExperience } from "./entry-experience";
import {
  WorkspaceRuntimeProvider,
  useWorkspaceRuntime,
} from "../features/workspace/WorkspaceRuntimeContext";

const DEMO_OVERRIDE_STORAGE_KEY = "echo-insight:workspace-mode:v1";
const DEMO_PREFERENCE_STORAGE_KEY = "echo-insight-ui-preferences-demo-v1";

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AuthenticatedApplication />
      </AuthProvider>
    </BrowserRouter>
  );
}

function AuthenticatedApplication() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const explicitDemo = resolveApplicationEntryExperience({
    authenticated: true,
    loading: false,
    pathname: location.pathname,
    search: location.search,
  }) === "demo";
  const [demoOverride, setDemoOverride] = useState(() => (
    explicitDemo || readDemoOverride()
  ));
  const entryExperience = resolveApplicationEntryExperience({
    authenticated: Boolean(auth.status?.authenticated),
    loading: auth.loading,
    pathname: location.pathname,
    search: location.search,
  });

  useLayoutEffect(() => {
    if (!explicitDemo || demoOverride) return;
    advanceClientCacheEpoch();
    writeDemoOverride(true);
    setDemoOverride(true);
  }, [demoOverride, explicitDemo]);

  const authenticated = Boolean(auth.status?.authenticated);
  const enterAccount = useCallback(() => {
    advanceClientCacheEpoch();
    writeDemoOverride(false);
    if (authenticated) {
      setDemoOverride(false);
      navigate("/", { replace: true });
      return;
    }
    void auth.startFeishuLogin();
  }, [auth, authenticated, navigate]);

  if (entryExperience === "loading") return <AuthLoadingScreen />;

  const mode = entryExperience === "demo" || demoOverride ? "demo" : "account";
  return (
    <WorkspaceRuntimeProvider
      authenticated={authenticated}
      key={mode}
      mode={mode}
      onEnterAccount={enterAccount}
    >
      <PreferenceProvider storageKey={mode === "demo" ? DEMO_PREFERENCE_STORAGE_KEY : undefined}>
        <EchoInsightApplication />
      </PreferenceProvider>
    </WorkspaceRuntimeProvider>
  );
}

function EchoInsightApplication() {
  const runtime = useWorkspaceRuntime();
  return (
    <AiAccessProvider>
      {runtime.mode === "demo" ? <ApplicationWorkspace /> : <AiAccessApplication />}
    </AiAccessProvider>
  );
}

function AiAccessApplication() {
  const aiAccess = useAiAccess();
  return (
    <AiSetupBoundary>
      <ApplicationWorkspace key={`ai-connection-${String(aiAccess.revision)}`} />
    </AiSetupBoundary>
  );
}

function ApplicationWorkspace() {
  const projectReport = useProjectReport();
  return (
    <ProjectProvider>
      <AppShell>
        <ApplicationRoutes projectReport={projectReport} />
      </AppShell>
    </ProjectProvider>
  );
}

function AuthLoadingScreen() {
  return (
    <main className="identity-entry identity-entry--loading" aria-busy="true">
      <WorkspacePreview />
      <section className="identity-entry-card identity-entry-card--loading"><span className="loading-spinner" /><p>正在准备你的项目空间…</p></section>
    </main>
  );
}

function ApplicationRoutes({
  projectReport,
}: {
  projectReport: ReturnType<typeof useProjectReport>;
}) {
  const location = useLocation();
  const runtime = useWorkspaceRuntime();
  const transitionRoot = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const cleanPageTransition = animatePageEnter(transitionRoot.current);

    return cleanPageTransition;
  }, [location.pathname]);

  useLayoutEffect(
    () => animateHighRiskEmphasis(transitionRoot.current),
    [location.pathname, projectReport.report],
  );

  return (
    <div className="page-transition-root" ref={transitionRoot}>
      <Routes location={location}>
        <Route path="/" element={<ProjectsPage />} />
        <Route path="/projects" element={<ProjectIndexRoute />} />
        <Route path="/projects/new" element={runtime.mode === "demo" ? <Navigate to="/" replace /> : <CreateProjectPage />} />
        <Route path="/projects/:projectId" element={<ProjectSpacePage view="overview" />} />
        <Route path="/projects/:projectId/risks" element={<ProjectSpacePage view="risks" />} />
        <Route path="/projects/:projectId/report" element={<ProjectSpacePage view="report" />} />
        <Route path="/projects/:projectId/data-source" element={<ProjectSpacePage view="data-source" />} />
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/risks" element={runtime.mode === "demo" ? <Navigate to="/projects" replace /> : <RiskCenterPage projectReport={projectReport} />} />
        <Route path="/report" element={runtime.mode === "demo" ? <Navigate to="/projects" replace /> : <AIReportPage projectReport={projectReport} />} />
        <Route path="/settings" element={<SettingsPage status={projectReport.status} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}

function readDemoOverride(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.sessionStorage.getItem(DEMO_OVERRIDE_STORAGE_KEY) === "demo";
  } catch {
    return false;
  }
}

function writeDemoOverride(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    if (enabled) window.sessionStorage.setItem(DEMO_OVERRIDE_STORAGE_KEY, "demo");
    else window.sessionStorage.removeItem(DEMO_OVERRIDE_STORAGE_KEY);
  } catch {
    // Session storage is only a navigation convenience; it never grants access.
  }
}

function ProjectIndexRoute() {
  const { projects, projectsLoading } = useProjects();
  const showLoading = useDelayedLoadingVisibility(projectsLoading);
  if (projectsLoading) return showLoading ? <div aria-busy="true"><p>正在打开项目空间…</p></div> : null;
  if (projects[0]) return <Navigate to={`/projects/${encodeURIComponent(projects[0].id)}`} replace />;
  return <Navigate to="/" replace />;
}
