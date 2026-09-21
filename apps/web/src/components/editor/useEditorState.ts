'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardSnapshot, EditorLease } from '@axp/contracts';
import {
  acquireLeaseAction,
  saveDraftAction,
  type SaveOutcome,
} from '@/app/dashboards/[dashboardId]/edit/actions';

/**
 * Editor session state: history, autosave and the lease (D3).
 *
 * The three are one hook because they are one fact. A change pushes history,
 * schedules a save, and refreshes the claim on the draft; separating them would
 * mean keeping three clocks in step.
 */

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'locked' | 'error';

export interface EditorStateOptions {
  readonly dashboardId: string;
  readonly initialSnapshot: DashboardSnapshot;
  readonly initialRevisionId: string;
  readonly initialLease: EditorLease | null;
  readonly heartbeatSeconds: number;
}

/** History depth. Enough to undo a session's worth of fiddling, not a log. */
const HISTORY_LIMIT = 50;
/** How long typing settles before a save goes out. */
const AUTOSAVE_DELAY_MS = 1200;

export interface EditorState {
  readonly snapshot: DashboardSnapshot;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly saveStatus: SaveStatus;
  readonly saveMessage: string | null;
  readonly savedAt: string | null;
  readonly lease: EditorLease | null;
  /** Records a change: history, autosave and lease all follow from it. */
  readonly commit: (next: DashboardSnapshot) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  readonly saveNow: () => void;
  readonly takeOver: () => void;
}

export function useEditorState(options: EditorStateOptions): EditorState {
  const { dashboardId, initialSnapshot, initialRevisionId, heartbeatSeconds } = options;

  const [past, setPast] = useState<DashboardSnapshot[]>([]);
  const [present, setPresent] = useState<DashboardSnapshot>(initialSnapshot);
  const [future, setFuture] = useState<DashboardSnapshot[]>([]);

  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [lease, setLease] = useState<EditorLease | null>(options.initialLease);

  const revisionId = useRef(initialRevisionId);
  const pending = useRef<DashboardSnapshot | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);

  const applyOutcome = useCallback((outcome: SaveOutcome) => {
    if (outcome.status === 'saved') {
      revisionId.current = outcome.revisionId ?? revisionId.current;
      setSavedAt(outcome.savedAt ?? null);
      setSaveStatus('saved');
      setSaveMessage(null);
      return;
    }

    setSaveStatus(outcome.status);
    setSaveMessage(outcome.message ?? null);
    if (outcome.lease !== undefined) setLease(outcome.lease);
  }, []);

  const flush = useCallback(async () => {
    const snapshot = pending.current;
    if (!snapshot || inFlight.current) return;

    pending.current = null;
    inFlight.current = true;
    setSaveStatus('saving');

    try {
      applyOutcome(await saveDraftAction(dashboardId, revisionId.current, snapshot));
    } finally {
      inFlight.current = false;
      // A change that arrived while the request was out still needs saving.
      if (pending.current) void flush();
    }
  }, [applyOutcome, dashboardId]);

  const schedule = useCallback(
    (snapshot: DashboardSnapshot) => {
      pending.current = snapshot;
      setSaveStatus('dirty');
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), AUTOSAVE_DELAY_MS);
    },
    [flush],
  );

  const commit = useCallback(
    (next: DashboardSnapshot) => {
      setPast((history) => [...history, present].slice(-HISTORY_LIMIT));
      // A new change abandons the redo branch: keeping it would let a user
      // "redo" their way into a layout that never existed.
      setFuture([]);
      setPresent(next);
      schedule(next);
    },
    [present, schedule],
  );

  const undo = useCallback(() => {
    setPast((history) => {
      const previous = history.at(-1);
      if (!previous) return history;

      setFuture((branch) => [present, ...branch]);
      setPresent(previous);
      schedule(previous);
      return history.slice(0, -1);
    });
  }, [present, schedule]);

  const redo = useCallback(() => {
    setFuture((branch) => {
      const next = branch[0];
      if (!next) return branch;

      setPast((history) => [...history, present].slice(-HISTORY_LIMIT));
      setPresent(next);
      schedule(next);
      return branch.slice(1);
    });
  }, [present, schedule]);

  const saveNow = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    void flush();
  }, [flush]);

  const takeOver = useCallback(() => {
    void acquireLeaseAction(dashboardId, true).then((result) => {
      setLease(result.lease);
      if (result.acquired) {
        setSaveStatus('dirty');
        setSaveMessage(null);
        saveNow();
      }
    });
  }, [dashboardId, saveNow]);

  // Heartbeat: keeps the claim alive while the editor is genuinely open, and
  // notices when somebody else has taken it over.
  useEffect(() => {
    const interval = setInterval(() => {
      void acquireLeaseAction(dashboardId).then((result) => {
        setLease(result.lease);
        if (!result.acquired) setSaveStatus('locked');
      });
    }, heartbeatSeconds * 1000);

    return () => clearInterval(interval);
  }, [dashboardId, heartbeatSeconds]);

  // A pending change must not be lost to a navigation or a closed tab.
  useEffect(() => {
    const onHide = () => {
      if (pending.current) void flush();
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [flush]);

  return useMemo(
    () => ({
      snapshot: present,
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      saveStatus,
      saveMessage,
      savedAt,
      lease,
      commit,
      undo,
      redo,
      saveNow,
      takeOver,
    }),
    [
      present,
      past.length,
      future.length,
      saveStatus,
      saveMessage,
      savedAt,
      lease,
      commit,
      undo,
      redo,
      saveNow,
      takeOver,
    ],
  );
}
