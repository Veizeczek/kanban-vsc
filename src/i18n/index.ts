import * as vscode from 'vscode';
import { pl } from './pl';
import { en } from './en';

export type Locale = typeof en;

const locales: Record<string, Locale> = { pl, en };

let configuredLang: string | null = null;

export function setConfiguredLanguage(lang: string | null): void {
  configuredLang = lang;
}

export function getLangCode(): string {
  if (configuredLang && locales[configuredLang]) {
    return configuredLang;
  }
  const vscodeLang = vscode.env.language ? vscode.env.language.split('-')[0] : 'en';
  return locales[vscodeLang] ? vscodeLang : 'en';
}

export function getLocale(): Locale {
  return locales[getLangCode()] ?? en;
}
