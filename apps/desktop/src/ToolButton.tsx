import { useId, type ButtonHTMLAttributes } from "react";
import { Icon, type IconName } from "./icons";

export function ToolButton({
  label,
  icon,
  description,
  iconOnly,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  icon?: IconName;
  description: string;
  iconOnly?: boolean;
}) {
  const id = useId();
  const classes = [className, iconOnly && icon ? "icon-only" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <span
      className="tool-control"
      tabIndex={props.disabled ? 0 : undefined}
      aria-label={props.disabled ? `${label}: ${description}` : undefined}
    >
      <button
        {...props}
        className={classes || undefined}
        aria-label={props["aria-label"] ?? label}
        aria-describedby={id}
      >
        {icon && <Icon name={icon} className="tool-symbol" />}
        <span className="tool-label">{children ?? label}</span>
      </button>
      <span id={id} role="tooltip" className="tool-tooltip">
        {description}
      </span>
    </span>
  );
}
