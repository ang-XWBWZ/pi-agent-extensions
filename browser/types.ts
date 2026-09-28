/**
 * extensions/browser/types.ts — 浏览器自动化核心类型定义
 */

export interface ChromeTabInfo {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export type BrowserActionType =
  | "click"
  | "type"
  | "press_key"
  | "scroll"
  | "navigate"
  | "wait";

export interface BrowserActionParams {
  action: BrowserActionType;
  tabId?: string;
  selector?: string;
  text?: string;
  key?: string;
  scrollDelta?: number;
  url?: string;
  timeoutMs?: number;
}

export interface PageExtractOptions {
  tabId?: string;
  url?: string;
  mode?: "active" | "headless";
  maxChars?: number;
  offset?: number;
}

export interface ExtractedPageResult {
  title: string;
  url: string;
  markdown: string;
  totalChars: number;
  truncated: boolean;
  nextOffset?: number;
}
