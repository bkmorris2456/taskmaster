interface EmptyStateProps {
  title: string;
  description: string;
}

export function EmptyState({ title, description }: EmptyStateProps) {
  return (
    <section
      aria-label={title}
      className="flex min-h-72 flex-col items-center justify-center px-5 py-12 text-center sm:min-h-96"
    >
      <span aria-hidden="true" className="mb-6 text-3xl text-accent">
        [ ]
      </span>
      <h2 className="text-base font-medium text-foreground">{title}</h2>
      <p className="mt-3 max-w-md text-sm leading-7 text-muted">
        {description}
      </p>
    </section>
  );
}
