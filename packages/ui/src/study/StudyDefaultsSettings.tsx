import {
  planCardOrderForAllDecks,
  studyOrderToNewCardOrder,
  type KnownEvent,
  type StudyMethod,
  type StudyOrder,
} from '@flash/core';
import { useApp } from '../state/AppContext.tsx';

const SELECT =
  'min-w-0 max-w-[55%] rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-1.5 text-sm';

/**
 * Settings › Study Preferences: the default study method and the card order for every deck.
 * Both are synced LWW preferences (`PreferencesChanged`); the order is also written to each deck's
 * `new_card_order` (`DeckSettingsChanged`), so per-deck options in Library keep working and can
 * override single decks afterwards. The Study screen can change either for one session.
 */
export function StudyDefaultsSettings() {
  const { state, getEventFactory, emitEvents, updatePreferences } = useApp();
  const method = state.preferences.study_method ?? 'schedule';
  const order = state.preferences.study_order ?? 'deck';
  const target = studyOrderToNewCardOrder(order);
  const overriding = [...state.decks.values()].filter(
    (d) => !d.archived && d.settings.new_card_order !== target,
  ).length;

  const applyOrder = (next: StudyOrder) => {
    const factory = getEventFactory();
    const nowMs = Date.now();
    const events: KnownEvent[] = [
      factory.create('PreferencesChanged', { preferences: { study_order: next } }, nowMs),
      ...planCardOrderForAllDecks(state, next).map((p) =>
        factory.create('DeckSettingsChanged', p, nowMs),
      ),
    ];
    emitEvents(events);
  };

  return (
    <>
      <label className="flex items-center justify-between gap-4 text-sm">
        <div className="min-w-0">
          <div className="font-medium">Default study method</div>
          <div className="text-xs text-[var(--muted)]">
            Practice reviews every card without changing your schedule.
          </div>
        </div>
        <select
          aria-label="Default study method"
          data-testid="settings-study-method"
          value={method}
          onChange={(e) => updatePreferences({ study_method: e.target.value as StudyMethod })}
          className={SELECT}
        >
          <option value="schedule">Spaced repetition</option>
          <option value="practice">Practice</option>
        </select>
      </label>

      <div className="flex flex-col gap-1.5">
        <label className="flex items-center justify-between gap-4 text-sm">
          <div className="min-w-0">
            <div className="font-medium">Card order (all decks)</div>
            <div className="text-xs text-[var(--muted)]">
              Deck order: new cards in list order, reviews by due date. Random: shuffled daily.
            </div>
          </div>
          <select
            aria-label="Card order for all decks"
            data-testid="settings-study-order"
            value={order}
            onChange={(e) => applyOrder(e.target.value as StudyOrder)}
            className={SELECT}
          >
            <option value="deck">Deck order</option>
            <option value="random">Random</option>
          </select>
        </label>
        {overriding > 0 && (
          <div className="flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
            <span data-testid="settings-study-order-overrides">
              {overriding === 1 ? '1 deck uses its' : `${overriding} decks use their`} own new-card
              order (Library › deck options).
            </span>
            <button
              type="button"
              data-testid="settings-study-order-apply"
              onClick={() => applyOrder(order)}
              className="shrink-0 rounded-lg border border-[var(--border)] px-2.5 py-1 font-semibold text-[var(--fg)] hover:bg-[var(--surface-2)]"
            >
              Apply to all
            </button>
          </div>
        )}
      </div>
    </>
  );
}
