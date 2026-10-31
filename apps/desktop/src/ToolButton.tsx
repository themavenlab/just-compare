import { useId, type ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./icons";

export function ToolButton({
  label,
  icon,
  description,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon?: IconName;
  description: string;
}) {
  const id = useId();
  return (
    <span
      className="tool-control"
      tabIndex={props.disabled ? 0 : undefined}
      aria-label={props.disabled ? `${label}: ${description}` : undefined}
    >
      <button
        {...props}
        aria-label={props["aria-label"] ?? label}
        aria-describedby={id}
        title={description}
      >
        {icon && <Icon name={icon} className="tool-symbol" />}
        <span>{children ?? label}</span>
      </button>
      <span id={id} role="tooltip" className="tool-tooltip">
        {description}
      </span>
    </span>
  );
}
