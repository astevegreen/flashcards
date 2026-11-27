import type { AnswerMode } from '@flash/core';
import { createElement, Fragment, Suspense, type ComponentType } from 'react';
import { lazyWithRetry } from '../../lazy/lazyWithRetry.tsx';
import { flipAnswerMode } from './FlipMode.tsx';
import type { AnswerModePlugin, AnswerModeRenderProps } from './types.ts';

function createLazyAnswerModePlugin(
  mode: AnswerMode,
  capturesFrontInteraction: boolean,
  loader: () => Promise<AnswerModePlugin>,
  loadingLabel: string,
): AnswerModePlugin {
  const LazyView = lazyWithRetry<ComponentType<AnswerModeRenderProps>>(async () => {
    const plugin = await loader();
    return {
      default: (props: AnswerModeRenderProps) =>
        createElement(Fragment, null, plugin.render(props)),
    };
  });

  return {
    mode,
    capturesFrontInteraction,
    render: (props) =>
      createElement(
        Suspense,
        {
          fallback: createElement(
            'div',
            { className: 'py-8 text-xs text-[var(--muted)]' },
            loadingLabel,
          ),
        },
        createElement(LazyView, props),
      ),
  };
}

const registry = new Map<AnswerMode, AnswerModePlugin>();

function registerAnswerMode(plugin: AnswerModePlugin): void {
  registry.set(plugin.mode, plugin);
}

export function getAnswerMode(mode: AnswerMode): AnswerModePlugin {
  return registry.get(mode) ?? flipAnswerMode;
}

// Keep Flip mode eager (0 ms fast-path default); strictly lazy-load all other answer modes (§8).
registerAnswerMode(flipAnswerMode);
registerAnswerMode(
  createLazyAnswerModePlugin(
    'typed',
    true,
    () => import('./TypedMode.tsx').then((m) => m.typedAnswerMode),
    'Loading typed mode…',
  ),
);
registerAnswerMode(
  createLazyAnswerModePlugin(
    'choice',
    true,
    () => import('./ChoiceMode.tsx').then((m) => m.choiceAnswerMode),
    'Loading choices…',
  ),
);
registerAnswerMode(
  createLazyAnswerModePlugin(
    'cloze',
    false,
    () => import('./ClozeMode.tsx').then((m) => m.clozeAnswerMode),
    'Loading cloze card…',
  ),
);
registerAnswerMode(
  createLazyAnswerModePlugin(
    'listen',
    false,
    () => import('./ListenMode.tsx').then((m) => m.listenAnswerMode),
    'Loading audio prompt…',
  ),
);
registerAnswerMode(
  createLazyAnswerModePlugin(
    'draw',
    true,
    () => import('./DrawMode.tsx').then((m) => m.drawAnswerMode),
    'Loading drawing canvas…',
  ),
);
