import { PiBrandLogo } from '../../../components/PiBrandLogo';

export function BrowserErrorState({
  title,
  summary,
  suggestions,
  errorCode,
  actionLabel,
  onAction,
}: {
  title: string;
  summary: string;
  suggestions: string[];
  errorCode: string;
  certificate?: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="gren-browser-error-overlay" role="alert">
      <div className="gren-browser-error-sheet">
        <span className="gren-browser-error-icon" aria-hidden="true">
          <PiBrandLogo size={28} tight />
        </span>
        <h1 className="gren-browser-error-title">{title}</h1>
        <p className="gren-browser-error-summary">{summary}</p>
        {suggestions.length > 0 ? (
          <div className="gren-browser-error-try">
            <p>尝试:</p>
            <ul>
              {suggestions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="gren-browser-error-code">{errorCode}</div>
        <button type="button" className="gren-browser-error-reload" onClick={onAction}>
          {actionLabel}
        </button>
      </div>
    </div>
  );
}
