export function ThinkingToggle({ checked, onChange, disabled, label, tip }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
  label: string;
  tip: string;
}) {
  return (
    <div className="thinking-control">
      <label className="thinking-switch">
        <input type="checkbox" role="switch" checked={checked} disabled={disabled}
          onChange={(event) => onChange(event.target.checked)} />
        <span aria-hidden className="thinking-switch-track" />
        <span>{label}</span>
      </label>
      <button type="button" className="thinking-help" aria-label={tip}
        title={tip} data-tooltip={tip}>i</button>
    </div>
  );
}
