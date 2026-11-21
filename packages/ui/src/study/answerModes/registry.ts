import type { AnswerMode } from '@flash/core';
import { choiceAnswerMode } from './ChoiceMode.tsx';
import { clozeAnswerMode } from './ClozeMode.tsx';
import { flipAnswerMode } from './FlipMode.tsx';
import { listenAnswerMode } from './ListenMode.tsx';
import { typedAnswerMode } from './TypedMode.tsx';
import type { AnswerModePlugin } from './types.ts';

const registry = new Map<AnswerMode, AnswerModePlugin>();

export function registerAnswerMode(plugin: AnswerModePlugin): void {
  registry.set(plugin.mode, plugin);
}

export function getAnswerMode(mode: AnswerMode): AnswerModePlugin {
  return registry.get(mode) ?? flipAnswerMode;
}

export function listRegisteredAnswerModes(): AnswerMode[] {
  return [...registry.keys()];
}

registerAnswerMode(flipAnswerMode);
registerAnswerMode(typedAnswerMode);
registerAnswerMode(choiceAnswerMode);
registerAnswerMode(clozeAnswerMode);
registerAnswerMode(listenAnswerMode);
