import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../../src/app/App';

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: () => ({
    offlineReady: [false, vi.fn()],
    needRefresh: [false, vi.fn()],
    updateServiceWorker: vi.fn(),
  }),
}));

function open(path = '/') {
  return render(
    <RouterProvider
      router={createMemoryRouter([{ path: '*', element: <App /> }], {
        initialEntries: [path],
      })}
    />,
  );
}

describe('application shell', () => {
  it('defaults to Big List with no sample tasks', async () => {
    open();
    expect(
      await screen.findByRole('heading', { name: 'Big List', level: 1 }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Big List' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Task title' })).toBeTruthy();
    expect(screen.getByText(/Cloud sync is not available yet/)).toBeTruthy();
  });

  it('moves heading focus and updates the title when navigating', async () => {
    open('/list');
    fireEvent.click(screen.getByRole('link', { name: 'Categories' }));
    const heading = await screen.findByRole('heading', {
      name: 'Categories',
      level: 1,
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(document.title).toBe('Categories · Taskmaster');
    expect(
      screen
        .getByRole('link', { name: 'Categories' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen
        .getByRole('link', { name: 'Big List' })
        .getAttribute('aria-current'),
    ).toBeNull();
  });

  it('shows a recovery link for an unknown route', () => {
    open('/missing');
    expect(
      screen.getByRole('heading', { name: 'View not found' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Open Big List' }));
    expect(
      screen.getByRole('heading', { name: 'Big List', level: 1 }),
    ).toBeTruthy();
  });
});
