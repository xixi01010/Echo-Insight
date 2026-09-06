import { Link } from "react-router-dom";
import { INTERACTIVE_SURFACE_CLASS } from "../animations/interactive-surface";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  showBackToOverview?: boolean;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  showBackToOverview = true,
}: PageHeaderProps) {
  return (
    <header className="page-heading page-heading--with-navigation">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {showBackToOverview ? (
        <Link
          className={`overview-back-link ${INTERACTIVE_SURFACE_CLASS.button}`}
          to="/"
        >
          <span aria-hidden="true">←</span>
          返回项目概览
        </Link>
      ) : null}
    </header>
  );
}
