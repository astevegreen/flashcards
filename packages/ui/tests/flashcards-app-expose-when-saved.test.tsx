// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type * as AppContextModule from '../src/state/AppContext.tsx';
import type { AppProviderProps } from '../src/state/AppContext.tsx';
import { createTestPlatform, testMeta } from './helpers/app-harness.tsx';

const seen = vi.hoisted(() => ({ props: [] as unknown[] }));

vi.mock('../src/state/AppContext.tsx', async (importOriginal) => ({
  ...(await importOriginal<typeof AppContextModule>()),
  AppProvider: (props: AppProviderProps) => {
    seen.props.push(props);
    return null;
  },
}));

const { FlashcardsApp } = await import('../src/FlashcardsApp.tsx');

describe('FlashcardsApp', () => {
  it('passes exposeWhenSaved through to AppProvider (the writer-lock handoff needs it)', async () => {
    const exposeWhenSaved = vi.fn();
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <FlashcardsApp
          platform={createTestPlatform()}
          initialMeta={testMeta()}
          exposeWhenSaved={exposeWhenSaved}
        />,
      );
    });
    expect(seen.props.at(-1)).toMatchObject({ exposeWhenSaved });
    await act(async () => {
      root.unmount();
    });
  });
});
