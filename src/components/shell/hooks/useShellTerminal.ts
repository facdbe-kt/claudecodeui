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

    // Manual touch-scroll: xterm's native viewport touch-scroll is unreliable
    // with the WebGL/canvas renderer (the canvas overlays the scroll
    // viewport), so a vertical swipe on mobile never reaches history. We
    // translate single-finger vertical drags into terminal.scrollLines().
    // Paired with `touch-action: none` on the .xterm subtree (index.css) so
    // the browser yields the gesture and honours preventDefault().
    const touchContainer = terminalContainerRef.current;
    let lastTouchY: number | null = null;

    // [DIAG bug1] on-screen overlay so mobile touch behaviour is visible
    // without remote devtools. Screenshot it on the phone, then remove.
    const dbg = document.createElement('div');
    dbg.id = 'shell-touch-debug';
    dbg.style.cssText =
      'position:absolute;top:4px;left:4px;z-index:50;max-width:92%;padding:4px 6px;' +
      'font:10px/1.35 monospace;color:#0f0;background:rgba(0,0,0,0.8);white-space:pre;' +
      'pointer-events:none;border-radius:4px;';
    dbg.textContent = 'touch-debug ready (swipe here)';
    touchContainer.appendChild(dbg);
    let tsCount = 0;
    let tmCount = 0;
    const getViewport = () => touchContainer.querySelector<HTMLElement>('.xterm-viewport');

    const renderDbg = (extra: string) => {
      const term = terminalRef.current;
      const viewport = getViewport();
      const ta = viewport ? getComputedStyle(viewport).touchAction : '?';
      const ydisp = term?.buffer.active.viewportY;
      const baseY = term?.buffer.active.baseY;
      dbg.textContent =
        `ts=${tsCount} tm=${tmCount} ta=${ta}\n` +
        `rows=${term?.rows} vpH=${viewport?.clientHeight ?? '?'} ydisp=${ydisp}/${baseY}\n` +
        `scrollTop=${viewport?.scrollTop ?? '?'} scrollH=${viewport?.scrollHeight ?? '?'}\n` +
        extra;
    };

    const handleTouchStart = (event: TouchEvent) => {
      tsCount += 1;
      if (event.touches.length !== 1) {
        lastTouchY = null;
        renderDbg(`start: touches=${event.touches.length} (ignored)`);
        return;
      }
      lastTouchY = event.touches[0].clientY;
      renderDbg(`start y=${Math.round(lastTouchY)}`);
    };

    const handleTouchMove = (event: TouchEvent) => {
      tmCount += 1;
      if (event.touches.length !== 1 || lastTouchY === null) {
        renderDbg(`move: touches=${event.touches.length} last=${lastTouchY} (ignored)`);
        return;
      }
      const currentY = event.touches[0].clientY;
      const dy = lastTouchY - currentY;
      lastTouchY = currentY;

      // Drive xterm's own scroll viewport directly. A programmatic scrollTop
      // change fires the viewport 'scroll' event that xterm listens to and
      // syncs its render against — this works regardless of touch-action or
      // the WebGL canvas overlay, unlike relying on scrollLines() alone.
      const viewport = getViewport();
      const before = viewport?.scrollTop ?? 0;
      if (viewport) {
        viewport.scrollTop = before + dy;
      }
      // Fallback in case the viewport isn't scrollable for some reason.
      if (viewport && viewport.scrollTop === before && dy !== 0) {
        terminalRef.current?.scrollLines(dy > 0 ? 1 : -1);
      }
      event.preventDefault();
      renderDbg(
        `dy=${dy} top:${Math.round(before)}->${Math.round(viewport?.scrollTop ?? 0)} cancelable=${event.cancelable}`,
      );
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
      // [DIAG bug2] container size + cols/rows at initial fit.
      console.log(
        `[DIAG bug2] init-fit containerW=${terminalContainerRef.current?.clientWidth} containerH=${terminalContainerRef.current?.clientHeight} cols=${currentTerminal.cols} rows=${currentTerminal.rows}`
      );
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
        // [DIAG bug2] container size + cols/rows on every resize-observer fit.
        console.log(
          `[DIAG bug2] resize-fit containerW=${terminalContainerRef.current?.clientWidth} containerH=${terminalContainerRef.current?.clientHeight} cols=${currentTerminal.cols} rows=${currentTerminal.rows}`
        );
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
      dbg.remove();
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
