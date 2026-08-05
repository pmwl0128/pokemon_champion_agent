import type { ReactNode } from "react";

export function PageHeader({
  title,
  description,
  children,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`page-header${className ? ` ${className}` : ""}`}>
      <div className="page-heading-row">
        <h1 className="page-title">{title}</h1>
        {children && <div className="page-heading-actions">{children}</div>}
      </div>
      {description && <p className="page-lead">{description}</p>}
    </header>
  );
}
