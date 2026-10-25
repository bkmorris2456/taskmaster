import { useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaStatus() {
  const [updateBlocked, setUpdateBlocked] = useState(false);
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const {
    offlineReady: [offlineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({ onRegisterError: () => setRegistrationFailed(true) });

  return (
    <aside
      aria-label="Application availability"
      className="border-t border-line px-5 py-4 text-xs leading-6 sm:px-8"
    >
      <p role="status" className="text-muted">
        {registrationFailed
          ? 'Offline setup unavailable. Reopen online to try again.'
          : offlineReady
            ? 'Application shell ready offline.'
            : 'Application shell preview.'}
      </p>
      {updateBlocked && (
        <p role="alert">
          Save or discard drafts and wait for local writes before updating.
        </p>
      )}
      {needRefresh && (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p>A new version is available.</p>
          <button
            className="action"
            onClick={() => {
              if (
                !window.dispatchEvent(
                  new Event('taskmaster:before-update', { cancelable: true }),
                )
              ) {
                setUpdateBlocked(true);
                return;
              }
              setUpdateBlocked(false);
              void updateServiceWorker(true).catch(() =>
                setRegistrationFailed(true),
              );
            }}
          >
            Reload to update
          </button>
          <button className="action" onClick={() => setNeedRefresh(false)}>
            Later
          </button>
        </div>
      )}
    </aside>
  );
}
