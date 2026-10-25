import type { Page } from '@playwright/test';

declare global {
  interface Window {
    failOutbox?: boolean;
  }
}

export async function installFailureProbe(page: Page) {
  await page.addInitScript(() => {
    function isAddRequest(value: unknown): value is IDBRequest<IDBValidKey> {
      return (
        value instanceof IDBRequest && value.source instanceof IDBObjectStore
      );
    }
    const add: unknown = Reflect.get(IDBObjectStore.prototype, 'add');
    if (typeof add !== 'function')
      throw new Error('Native IndexedDB add is unavailable.');
    IDBObjectStore.prototype.add = function (
      value: unknown,
      key?: IDBValidKey,
    ) {
      if (this.name === 'outbox' && window.failOutbox)
        throw new DOMException(
          'Injected test quota failure',
          'QuotaExceededError',
        );
      const request: unknown = Reflect.apply(
        add,
        this,
        key === undefined ? [value] : [value, key],
      );
      if (!isAddRequest(request))
        throw new Error('Unexpected IndexedDB request.');
      return request;
    };
  });
}
