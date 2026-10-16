import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

import { openWS, type WSStatus } from "@/lib/ws";

// Send ships one raw WS frame (already serialized) to the server.
export type Send = (data: string) => void;

// A ConsoleAttachment is the per-session wiring for one terminal: it holds
// any protocol-specific state (e.g. RCON's line-edit buffer) in its
// closures. The hook calls protocol.attach() exactly once per session.
export interface ConsoleAttachment {
  // Handle one inbound WS frame (raw string) — parse and write to the term.
  onMessage: (data: string) => void;
  // Handle a chunk of user keystrokes from xterm.onData.
  onData: (d: string) => void;
  // Fired after the socket (re)opens — e.g. PTY sends an initial resize.
  onSocketOpen?: () => void;
  // Fired when xterm reports a geometry change — e.g. PTY sends a resize.
  onTermResize?: () => void;
  // Send a single line entered in the command bar.
  sendCommand: (line: string) => void;
}

export interface ConsoleProtocol {
  // WebSocket path; also the session identity the lifecycle effect keys on.
  wsPath: string;
  // Server name, used for the downloaded log filename.
  name: string;
  // Status lines written once per connect/disconnect transition.
  connectLabel: string;
  disconnectLabel: string;
  backlog: () => Promise<string[]>;
  attach: (term: Terminal, send: Send) => ConsoleAttachment;
}

export interface ConsoleHandle {
  hostRef: RefObject<HTMLDivElement | null>;
  status: WSStatus;
  clear: () => void;
  download: () => void;
  toggleFullscreen: () => void;
  sendCommand: (line: string) => void;
}

export function useConsoleTerminal(proto: ConsoleProtocol): ConsoleHandle {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sockRef = useRef<{ send: Send; close: () => void } | null>(null);
  const attRef = useRef<ConsoleAttachment | null>(null);
  const disposedRef = useRef(false);
  // Keep the latest protocol reachable from the lifecycle effect without
  // re-running it (the effect keys only on wsPath). Assigning ref.current
  // must not happen during render, so this runs in a layout effect —
  // synchronously after commit, before the lifecycle effect below (layout
  // effects always run before passive effects) and before any paint.
  const protoRef = useRef(proto);
  useLayoutEffect(() => {
    protoRef.current = proto;
  });

  const [status, setStatus] = useState<WSStatus>("connecting");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    disposedRef.current = false;

    const term = new Terminal({
      theme: { background: "#0b0b0d" },
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 13,
      cursorBlink: true,
      // A sane default; the first fit() (and PTY resize frames) override it.
      cols: 100,
      rows: 30,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // B1: fit() reaches into the renderer's dimensions, which are undefined
    // before the renderer is ready or after dispose(). Guard every call so
    // a stale ResizeObserver/rAF firing during StrictMode remount or a tab
    // switch can't throw "Cannot read properties of undefined".
    const safeFit = () => {
      if (disposedRef.current) return;
      if (!term.element?.isConnected) return;
      try {
        fit.fit();
      } catch {
        // Renderer not ready yet, or mid-teardown — the guards above catch
        // the common cases; this is defense-in-depth against the upstream
        // race, not a silenced lint rule.
      }
    };
    // Defer the initial fit until after layout so the host has dimensions.
    const raf = requestAnimationFrame(safeFit);
    // Refit on container resize (correct) rather than only window resize.
    const ro = new ResizeObserver(safeFit);
    ro.observe(host);

    const send: Send = (d) => sockRef.current?.send(d);

    // B2: write a status line only on a connected<->disconnected edge so an
    // unreachable agent doesn't flood the buffer; the ongoing "reconnecting"
    // state is surfaced via `status` to the chrome instead.
    let prevConnected: boolean | null = null;
    let cancelled = false;
    let sock: { send: Send; close: () => void } | null = null;
    const connect = () => {
      sock = openWS(proto.wsPath, {
        onMessage: (data) => {
          if (typeof data === "string") attRef.current?.onMessage(data);
        },
        onStatus: (s) => {
          // A reconnect/close can land after teardown (sock.close() during
          // cleanup fires onclose); don't touch a disposed terminal or set
          // state on an unmounted component.
          if (disposedRef.current) return;
          setStatus(s);
          if (s === "open" && prevConnected !== true) {
            term.writeln(`\x1b[90m${protoRef.current.connectLabel}\x1b[0m`);
            prevConnected = true;
          } else if ((s === "reconnecting" || s === "closed") && prevConnected === true) {
            term.writeln(`\x1b[31m${protoRef.current.disconnectLabel}\x1b[0m`);
            prevConnected = false;
          }
        },
        onOpen: () => attRef.current?.onSocketOpen?.(),
      });
      sockRef.current = sock;
    };
    void protoRef.current
      .backlog()
      .catch((): string[] => [])
      .then((lines) => {
        if (cancelled) return;
        if (lines.length > 0) term.write(lines.map((line) => `${line}\r\n`).join(""));
        connect();
      });

    const att = protoRef.current.attach(term, send);
    attRef.current = att;

    const dataDisp = term.onData((d) => att.onData(d));
    const resizeDisp = term.onResize(() => att.onTermResize?.());

    return () => {
      // Mark disposed first so any in-flight rAF/observer callback no-ops.
      disposedRef.current = true;
      cancelled = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      dataDisp.dispose();
      resizeDisp.dispose();
      sock?.close();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      sockRef.current = null;
      attRef.current = null;
    };
  }, [proto.wsPath]);

  return {
    hostRef,
    status,
    clear: () => termRef.current?.clear(),
    download: () => {
      const term = termRef.current;
      if (!term) return;
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        lines.push(buf.getLine(i)?.translateToString(true) ?? "");
      }
      const blob = new Blob([lines.join("\n")], { type: "text/plain" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${protoRef.current.name}-console.log`;
      a.click();
      URL.revokeObjectURL(url);
    },
    toggleFullscreen: () => {
      const host = hostRef.current;
      if (!host) return;
      if (document.fullscreenElement) {
        void document.exitFullscreen();
      } else {
        void host.requestFullscreen();
      }
    },
    sendCommand: (line: string) => attRef.current?.sendCommand(line),
  };
}
