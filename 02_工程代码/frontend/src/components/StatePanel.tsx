import { INTERACTIVE_SURFACE_CLASS } from "../animations/interactive-surface";

interface StatePanelProps {
  title: string;
  description: string;
  action?: { label: string; onClick: () => void; disabled?: boolean };
}

export function StatePanel({ title, description, action }: StatePanelProps) {
  return (
    <section className={`state-panel ${INTERACTIVE_SURFACE_CLASS.card}`}>
      <h2>{title}</h2>
      <p>{description}</p>
      {action && (
        <button
          aria-busy={action.disabled}
          className={`weui-btn weui-btn_primary ${INTERACTIVE_SURFACE_CLASS.button}`}
          disabled={action.disabled}
          onClick={action.onClick}
          type="button"
        >
          {action.label}
        </button>
      )}
    </section>
  );
}
