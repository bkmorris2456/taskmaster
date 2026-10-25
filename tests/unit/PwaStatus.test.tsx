import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PwaStatus } from '../../src/app/PwaStatus';

const state = vi.hoisted(() => ({
  ready: false,
  refresh: false,
  setRefresh: vi.fn(),
  update: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    offlineReady: [state.ready, vi.fn()],
    needRefresh: [state.refresh, state.setRefresh],
    updateServiceWorker: state.update,
  }),
}));

describe('PWA availability', () => {
  it('only claims offline readiness after the worker reports it', () => {
    state.ready = false;
    state.refresh = false;
    const view = render(<PwaStatus />);
    expect(screen.getByRole('status').textContent).toBe(
      'Application shell preview.',
    );
    state.ready = true;
    view.rerender(<PwaStatus />);
    expect(screen.getByRole('status').textContent).toBe(
      'Application shell ready offline.',
    );
  });

  it('waits for a user action before applying an update', () => {
    state.refresh = true;
    render(<PwaStatus />);
    expect(state.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(state.setRefresh).toHaveBeenCalledWith(false);
    expect(state.update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reload to update' }));
    expect(state.update).toHaveBeenCalledWith(true);
  });
});

it('does not reload a worker update over an unsaved draft or pending local write', () => {
  state.refresh = true;
  render(<PwaStatus />);
  const block = (event: Event) => event.preventDefault();
  window.addEventListener('taskmaster:before-update', block);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Reload to update' }));
    expect(state.update).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toContain(
      'Save or discard drafts',
    );
  } finally {
    window.removeEventListener('taskmaster:before-update', block);
  }
});
