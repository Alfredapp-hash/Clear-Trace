/**
 * Minimal front-matter reader for skills/<id>/SKILL.md (replaces gray-matter).
 *
 * Supports exactly the flat YAML subset the skill files use:
 *
 *   ---
 *   key: scalar            # string, true/false, integer/decimal, "quoted" or 'quoted'
 *   key: []                # empty list
 *   key: [a, b]            # inline list of scalars
 *   key:                   # block list:
 *     - item
 *   ---
 *
 * Anything else (nested maps, multi-line strings, anchors…) throws, so a SKILL.md that
 * outgrows the subset fails loudly in tests instead of being misread.
 */

export type FrontMatterScalar = string | number | boolean | null;
export type FrontMatterValue = FrontMatterScalar | FrontMatterScalar[];

export interface ParsedFrontMatter {
  data: Record<string, FrontMatterValue>;
  content: string;
}

const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/;
const LIST_ITEM = /^\s+-\s+(.*)$/;

function stripComment(value: string): string {
  // Only unquoted values can carry a trailing " # comment".
  if (/^["']/.test(value)) return value;
  const idx = value.search(/\s#/);
  return idx === -1 ? value : value.slice(0, idx).trimEnd();
}

function parseScalar(raw: string, lineNo: number): FrontMatterScalar {
  const value = stripComment(raw.trim());
  if (value === "" || value === "~" || value === "null") return null;
  const quoted = value.match(/^"(.*)"$/) ?? value.match(/^'(.*)'$/);
  if (quoted) return quoted[1]!;
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  // "1.0.0" stays a string; "1.5" is a number (as in YAML).
  if (/^-?\d+\.\d+$/.test(value)) return Number(value);
  if (/^[[{|>&*!]/.test(value)) {
    throw new Error(`Unsupported front matter syntax on line ${lineNo}: ${value}`);
  }
  return value;
}

function parseValue(raw: string, lineNo: number): FrontMatterValue {
  const value = stripComment(raw.trim());
  const inline = value.match(/^\[(.*)\]$/);
  if (!inline) return parseScalar(value, lineNo);
  const body = inline[1]!.trim();
  if (!body) return [];
  return body.split(",").map((part) => parseScalar(part, lineNo));
}

export function parseFrontMatter(source: string): ParsedFrontMatter {
  const text = source.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return { data: {}, content: text };

  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) throw new Error("Unterminated front matter (missing closing ---)");

  const data: Record<string, FrontMatterValue> = {};
  let listKey: string | null = null;

  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    const lineNo = i + 1;
    if (!line.trim() || line.trim().startsWith("#")) continue;

    const item = line.match(LIST_ITEM);
    if (item) {
      if (!listKey) throw new Error(`List item without a key on line ${lineNo}`);
      const list = (data[listKey] ??= []) as FrontMatterScalar[];
      list.push(parseScalar(item[1]!, lineNo));
      continue;
    }

    const kv = line.match(KEY_LINE);
    if (!kv) throw new Error(`Unsupported front matter syntax on line ${lineNo}: ${line.trim()}`);
    const [, key, rest] = kv;
    if (Object.prototype.hasOwnProperty.call(data, key!)) {
      throw new Error(`Duplicate front matter key "${key}" on line ${lineNo}`);
    }
    if (rest === undefined || stripComment(rest.trim()) === "") {
      // A bare "key:" is null in YAML until list items follow.
      data[key!] = null;
      listKey = key!;
    } else {
      data[key!] = parseValue(rest, lineNo);
      listKey = null;
    }
  }

  // gray-matter drops the newline that follows the closing ---.
  const content = lines.slice(end + 1).join("\n");
  return { data, content };
}
