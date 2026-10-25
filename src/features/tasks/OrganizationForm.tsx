import { useEffect, useRef, useState } from 'react';

export function OrganizationForm({
  initialName,
  label,
  busy,
  save,
  cancel,
  dirtyChanged,
}: {
  initialName: string;
  label: string;
  busy: boolean;
  save: (name: string) => Promise<boolean>;
  cancel: () => void;
  dirtyChanged: (value: boolean) => void;
}) {
  const [name, setName] = useState(initialName);
  const input = useRef<HTMLInputElement>(null);
  const dirty = name !== initialName;
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    dirtyChanged(dirty);
    return () => dirtyChanged(false);
  }, [dirty, dirtyChanged]);
  const close = () => {
    if (!dirty || window.confirm('Discard this unsaved name?')) cancel();
  };
  return (
    <form
      aria-label={label}
      className="border-b border-line p-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save(name);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) {
          event.preventDefault();
          close();
        }
      }}
    >
      <label className="block text-xs text-muted">
        {label}
        <input
          ref={input}
          className="field my-2 w-full"
          maxLength={80}
          readOnly={busy}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <button className="action" disabled={busy}>
          Save name
        </button>
        <button
          type="button"
          className="action"
          disabled={busy}
          onClick={close}
        >
          Cancel name
        </button>
      </div>
    </form>
  );
}
