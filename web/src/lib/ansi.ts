import type { CSSProperties } from "react";

export interface AnsiSegment {
  text: string;
  style?: CSSProperties;
}

interface AnsiState {
  color?: string;
  bold?: boolean;
}

const ESC = String.fromCharCode(27);
const CSI = /^\[([0-9;]*)([A-Za-z])/;
const BASIC = ["#71717a", "#f87171", "#4ade80", "#facc15", "#60a5fa", "#e879f9", "#22d3ee", "#d4d4d8"];
const BRIGHT = ["#a1a1aa", "#fca5a5", "#86efac", "#fde047", "#93c5fd", "#f0abfc", "#67e8f9", "#fafafa"];
const CUBE = [0, 95, 135, 175, 215, 255];

function color256(index: number): string | undefined {
  if (index < 8) return BASIC[index];
  if (index < 16) return BRIGHT[index - 8];
  if (index < 232) {
    const offset = index - 16;
    return `rgb(${CUBE[Math.floor(offset / 36)]}, ${CUBE[Math.floor(offset / 6) % 6]}, ${CUBE[offset % 6]})`;
  }
  if (index < 256) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level}, ${level}, ${level})`;
  }
  return undefined;
}

function applySgr(state: AnsiState, params: string): AnsiState {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  let next = { ...state };
  for (let index = 0; index < codes.length; index++) {
    const code = codes[index];
    const mode = codes[index + 1];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 22) next.bold = false;
    else if (code === 39) next.color = undefined;
    else if (code >= 30 && code <= 37) next.color = BASIC[code - 30];
    else if (code >= 90 && code <= 97) next.color = BRIGHT[code - 90];
    else if ((code === 38 || code === 48) && mode === 5) {
      if (code === 38) next.color = color256(codes[index + 2]);
      index += 2;
    } else if ((code === 38 || code === 48) && mode === 2) {
      if (code === 38) next.color = `rgb(${codes[index + 2]}, ${codes[index + 3]}, ${codes[index + 4]})`;
      index += 4;
    }
  }
  return next;
}

export function parseAnsi(line: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let state: AnsiState = {};
  line.split(ESC).forEach((chunk, index) => {
    let text = chunk;
    const match = index > 0 ? CSI.exec(chunk) : null;
    if (match) {
      if (match[2] === "m") state = applySgr(state, match[1]);
      text = chunk.slice(match[0].length);
    }
    if (!text) return;
    segments.push(state.color || state.bold ? { text, style: { color: state.color, fontWeight: state.bold ? 600 : undefined } } : { text });
  });
  return segments;
}
