import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { INTERACTIVE_SURFACE_CLASS } from "../../animations/interactive-surface";
import { PageHeader } from "../../components/PageHeader";
import { useProjects } from "../../features/projects/ProjectContext";
import { useWorkspaceRuntime } from "../../features/workspace/WorkspaceRuntimeContext";
import {
  getCreateProjectErrorMessage,
  normalizeProjectNameInput,
  PROJECT_NAME_MAX_LENGTH,
} from "../../features/projects/project-creation";

export function CreateProjectPage() {
  const client = useWorkspaceRuntime().projectClient;
  const navigate = useNavigate();
  const { refreshProjects } = useProjects();
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedName = normalizeProjectNameInput(name);
    if (!normalizedName) {
      setError("请输入有效的项目名称。");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const project = await client.createProject(normalizedName);
      await refreshProjects();
      navigate(`/projects/${encodeURIComponent(project.id)}`, { replace: true });
    } catch (caughtError) {
      setError(getCreateProjectErrorMessage(caughtError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="page-stack create-project-page">
      <PageHeader
        description="先创建 Echo Insight 项目；数据源可以在项目内稍后绑定。"
        eyebrow="个人项目控制台"
        title="创建项目"
      />
      <form className="project-form" onSubmit={(event) => void submit(event)}>
        <label>
          <span>项目名称</span>
          <input
            autoFocus
            disabled={submitting}
            maxLength={PROJECT_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：产品发布准备"
            value={name}
          />
        </label>
        <p className="project-form__role">你将成为该项目的负责人。项目创建者与负责人会分别记录。</p>
        {error ? <p className="inline-alert" role="alert">{error}</p> : null}
        <button className={`weui-btn weui-btn_primary ${INTERACTIVE_SURFACE_CLASS.button}`} disabled={submitting} type="submit">
          {submitting ? "正在创建…" : "创建项目"}
        </button>
      </form>
    </div>
  );
}
