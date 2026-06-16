import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import type { Project } from '../../../types/app';
import {
  CODEX_DEVICE_AUTH_URL,
  TERMINAL_INIT_DELAY_MS,
  TERMINAL_OPTIONS,
  TERMINAL_RESIZE_DELAY_MS,
} from '../constants/constants';
import { copyTextToClipboard } from '../../../utils/clipboard';
import { isCodexLoginCommand } from '../utils/auth';
import { sendSocketMessage } from '../utils/socket';
import { ensureXtermFocusStyles } from '../utils/terminalStyles';

type UseShellTerminalOptions = {
  terminalContainerRef: RefObject<HTMLDivElement>;
  terminalRef: MutableRefObject<Terminal | null>;
  fitAddonRef: MutableRefObject<FitAddon | null>;
  wsRef: MutableRefObject<WebSocket | null>;
  selectedProject: Project | null | undefined;
  minimal: boolean;
  isRestarting: boolean;
  initialCommandRef: MutableRefObject<string | null | undefined>;
  isPlainShellRef: MutableRefObject<boolean>;
  authUrlRef: MutableRefObject<string>;
  copyAuthUrlToClipboard: (url?: string) => Promise<boolean>;
  closeSocket: () => void;
};

type UseShellTerminalResult = {
  isInitialized: boolean;
  clearTerminalScreen: () => void;
  disposeTerminal: () => void;
};

export function useShellTerminal({
  terminalContainerRef,
  terminalRef,
  fitAddonRef,
  wsRef,
  selectedProject,
  minimal,
  isRestarting,
  initialCommandRef,
  isPlainShellRef,
  authUrlRef,
  copyAuthUrlToClipboard,
  closeSocket,
}: UseShellTerminalOptions): UseShellTerminalResult {
  const [isInitialized, setIsInitialized] = useState(false);
  const resizeTimeoutRef = useRef<number | null>(null);
  const selectedProjectKey = selectedProject?.fullPath || selectedProject?.path || '';
  const hasSelectedProject = Boolean(selectedProject);

  useEffect(() => {
    ensureXtermFocusStyles();
  }, []);

  const clearTerminalScreen = useCallback(() => {
    if (!terminalRef.current) {
      return;
    }

    terminalRef.current.clear();
    terminalRef.current.write('\x1b[2J\x1b[H');
  }, [terminalRef]);

  const disposeTerminal = useCallback(() => {
    if (terminalRef.current) {
      terminalRef.current.dispose();
      terminalRef.current = null;
    }

    fitAddonRef.current = null;
    setIsInitialized(false);
  }, [fitAddonRef, terminalRef]);

  useEffect(() => {
    if (!terminalContainerRef.current || !hasSelectedProject || isRestarting || terminalRef.current) {
      return;
    }

    const nextTerminal = new Terminal(TERMINAL_OPTIONS);
    terminalRef.current = nextTerminal;

    const nextFitAddon = new FitAddon();
    fitAddonRef.current = nextFitAddon;
    nextTerminal.loadAddon(nextFitAddon);

    // Avoid wrapped partial links in compact login flows.
    if (!minimal) {
      nextTerminal.loadAddon(new WebLinksAddon());
    }

    try {
      nextTerminal.loadAddon(new WebglAddon());
    } catch {
      console.warn('[Shell] WebGL renderer unavailable, using Canvas fallback');
    }

    nextTerminal.open(terminalContainerRef.current);

    // Touch-scroll. The terminal usually runs a full-screen CLI on the
    // alternate screen buffer, which has no xterm scrollback to move — desktop
    // scrolling works only because the mouse wheel is forwarded to the app. So
    // we translate single-finger vertical swipes into wheel events dispatched
    // to xterm's viewport, letting xterm apply its existing mode-aware handling
    // (scroll scrollback in the normal buffer; forward wheel/arrow sequences to
    // the app on the alternate screen) — exactly like a desktop wheel.
    //
    // Dispatching is coalesced into one wheel event per animation frame: a
    // touchmove fires far more often than the app can repaint, and flushing on
    // every event floods the PTY with escape sequences, producing stutter and
    // ghosting. Paired with `touch-action: none` on the .xterm subtree
    // (index.css) so the browser yields the gesture and honours preventDefault.
    const touchContainer = terminalContainerRef.current;
    const getViewport = () => touchContainer.querySelector<HTMLElement>('.xterm-viewport');
    let lastTouchY: number | null = null;
    let scrollAccumPx = 0;
    let scrollRafId: number | null = null;

    const flushTouchScroll = () => {
      scrollRafId = null;
      const term = terminalRef.current;
      const viewport = getViewport();
      if (!term || !viewport) {
        return;
      }
      const cell = term.rows ? viewport.clientHeight / term.rows : 17;
      const lines = Math.trunc(scrollAccumPx / cell);
      if (lines === 0) {
        return;
      }
      scrollAccumPx -= lines * cell;
      viewport.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: lines,
          deltaMode: 1, // DOM_DELTA_LINE
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        lastTouchY = null;
        return;
      }
      lastTouchY = event.touches[0].clientY;
      scrollAccumPx = 0;
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1 || lastTouchY === null) {
        return;
      }
      const currentY = event.touches[0].clientY;
      scrollAccumPx += lastTouchY - currentY;
      lastTouchY = currentY;
      event.preventDefault();
      if (scrollRafId === null) {
        scrollRafId = window.requestAnimationFrame(flushTouchScroll);
      }
    };

    const handleTouchEnd = () => {
      lastTouchY = null;
    };

    touchContainer.addEventListener('touchstart', handleTouchStart, { passive: true });
    touchContainer.addEventListener('touchmove', handleTouchMove, { passive: false });
    touchContainer.addEventListener('touchend', handleTouchEnd, { passive: true });
    touchContainer.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    const copyTerminalSelection = async () => {
      const selection = nextTerminal.getSelection();
      if (!selection) {
        return false;
      }

      return copyTextToClipboard(selection);
    };

    const handleTerminalCopy = (event: ClipboardEvent) => {
      if (!nextTerminal.hasSelection()) {
        return;
      }

      const selection = nextTerminal.getSelection();
      if (!selection) {
        return;
      }

      event.preventDefault();

      if (event.clipboardData) {
        event.clipboardData.setData('text/plain', selection);
        return;
      }

      void copyTextToClipboard(selection);
    };

    terminalContainerRef.current.addEventListener('copy', handleTerminalCopy);

    nextTerminal.attachCustomKeyEventHandler((event) => {
      const activeAuthUrl = isCodexLoginCommand(initialCommandRef.current)
        ? CODEX_DEVICE_AUTH_URL
        : authUrlRef.current;

      if (
        event.type === 'keydown' &&
        minimal &&
        isPlainShellRef.current &&
        activeAuthUrl &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        event.key?.toLowerCase() === 'c'
      ) {
        event.preventDefault();
        event.stopPropagation();
        void copyAuthUrlToClipboard(activeAuthUrl);
        return false;
      }

      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'c' &&
        nextTerminal.hasSelection()
      ) {
        event.preventDefault();
        event.stopPropagation();
        void copyTerminalSelection();
        return false;
      }

      if (
        event.type === 'keydown' &&
        (event.ctrlKey || event.metaKey) &&
        event.key?.toLowerCase() === 'v'
      ) {
        // Block native paste so data is only injected after clipboard-read resolves.
        event.preventDefault();
        event.stopPropagation();

        if (typeof navigator !== 'undefined' && navigator.clipboard?.readText) {
          navigator.clipboard
            .readText()
            .then((text) => {
              sendSocketMessage(wsRef.current, {
                type: 'input',
                data: text,
              });
            })
            .catch(() => {});
        }

        return false;
      }

      return true;
    });

    window.setTimeout(() => {
      const currentFitAddon = fitAddonRef.current;
      const currentTerminal = terminalRef.current;
      if (!currentFitAddon || !currentTerminal) {
        return;
      }

      currentFitAddon.fit();
      sendSocketMessage(wsRef.current, {
        type: 'resize',
        cols: currentTerminal.cols,
        rows: currentTerminal.rows,
      });
    }, TERMINAL_INIT_DELAY_MS);

    setIsInitialized(true);

    const dataSubscription = nextTerminal.onData((data) => {
      sendSocketMessage(wsRef.current, {
        type: 'input',
        data,
      });
    });

    const resizeObserver = new ResizeObserver(() => {
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
      }

      resizeTimeoutRef.current = window.setTimeout(() => {
        const currentFitAddon = fitAddonRef.current;
        const currentTerminal = terminalRef.current;
        if (!currentFitAddon || !currentTerminal) {
          return;
        }

        currentFitAddon.fit();
        sendSocketMessage(wsRef.current, {
          type: 'resize',
          cols: currentTerminal.cols,
          rows: currentTerminal.rows,
        });
      }, TERMINAL_RESIZE_DELAY_MS);
    });

    resizeObserver.observe(terminalContainerRef.current);

    return () => {
      terminalContainerRef.current?.removeEventListener('copy', handleTerminalCopy);
      touchContainer.removeEventListener('touchstart', handleTouchStart);
      touchContainer.removeEventListener('touchmove', handleTouchMove);
      touchContainer.removeEventListener('touchend', handleTouchEnd);
      touchContainer.removeEventListener('touchcancel', handleTouchEnd);
      if (scrollRafId !== null) {
        window.cancelAnimationFrame(scrollRafId);
      }
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current !== null) {
        window.clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = null;
      }
      dataSubscription.dispose();
      closeSocket();
      disposeTerminal();
    };
  }, [
    authUrlRef,
    closeSocket,
    copyAuthUrlToClipboard,
    disposeTerminal,
    fitAddonRef,
    initialCommandRef,
    isPlainShellRef,
    isRestarting,
    minimal,
    hasSelectedProject,
    selectedProjectKey,
    terminalContainerRef,
    terminalRef,
    wsRef,
  ]);

  return {
    isInitialized,
    clearTerminalScreen,
    disposeTerminal,
  };
}
