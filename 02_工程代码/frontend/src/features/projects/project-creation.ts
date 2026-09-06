import { ProjectApiError } from "../../services/api/projects.js";

export const PROJECT_NAME_MAX_LENGTH = 120;

export function normalizeProjectNameInput(value: string): string | null {
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > PROJECT_NAME_MAX_LENGTH
    || /[\u0000-\u001f\u007f-\u009f]/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

export function getCreateProjectErrorMessage(error: unknown): string {
  if (error instanceof ProjectApiError && error.code === "INVALID_PROJECT_NAME") {
    return "请输入有效的项目名称。";
  }
  return "暂时无法创建项目，请稍后重试。";
}
