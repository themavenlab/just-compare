import { useId, type ButtonHTMLAttributes } from "react";

export function ToolButton({
  label,
  symbol,
  description,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  symbol?: string;
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
        {symbol && (
          <span aria-hidden="true" className="tool-symbol">
            {symbol}
          </span>
        )}
        <span>{children ?? label}</span>
      </button>
      <span id={id} role="tooltip" className="tool-tooltip">
        {description}
      </span>
    </span>
  );
}
