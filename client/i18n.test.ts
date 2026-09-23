import { describe, expect, it } from "vitest";
import {
  PLUGIN_LOCALES,
  PLUGIN_STRING_KEYS,
  detectSystemLocale,
  pluginLocaleKeys,
  resolvePluginLocaleFromTags,
  resolveUiLocale,
  translate,
} from "./i18n";

describe("resolvePluginLocaleFromTags", () => {
  it.each([
    ["en-US", "en"],
    ["en", "en"],
    ["zh-CN", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh", "zh-CN"],
    ["pt-BR", "pt-BR"],
    ["pt", "pt-BR"],
    ["ja-JP", "ja"],
    ["ko-KR", "ko"],
    ["fr-FR", "fr"],
    ["es-MX", "es"],
    ["ru-RU", "ru"],
    ["ar-EG", "ar"],
  ] as const)("maps %s to %s", (tag, expected) => {
    expect(resolvePluginLocaleFromTags([tag])).toBe(expected);
  });

  it("falls back to English for unsupported tags, matching the host", () => {
    expect(resolvePluginLocaleFromTags(["de-DE"])).toBe("en");
    // The host has no Traditional Chinese resource; stay consistent with it.
    expect(resolvePluginLocaleFromTags(["zh-TW"])).toBe("en");
    expect(resolvePluginLocaleFromTags([])).toBe("en");
  });

  it("prefers the first supported tag", () => {
    expect(resolvePluginLocaleFromTags(["de-DE", "ja-JP"])).toBe("ja");
  });
});

describe("detectSystemLocale", () => {
  it("never throws and always returns a supported locale", () => {
    expect(PLUGIN_LOCALES).toContain(detectSystemLocale());
  });
});

describe("resolveUiLocale", () => {
  it("pins an explicit choice", () => {
    expect(resolveUiLocale("ja")).toBe("ja");
    expect(resolveUiLocale("pt-BR")).toBe("pt-BR");
  });

  it("resolves system to a supported locale", () => {
    expect(PLUGIN_LOCALES).toContain(resolveUiLocale("system"));
  });
});

describe("translate", () => {
  it("renders every locale for a shared key", () => {
    expect(translate("en", "settingsTitle")).toBe("Translate");
    expect(translate("zh-CN", "settingsTitle")).toBe("翻译");
    expect(translate("ja", "retryTranslation")).toBe("翻訳を再試行");
  });

  it("interpolates vars and leaves unknown placeholders verbatim", () => {
    expect(translate("en", "providersLoadError", { error: "boom" })).toBe(
      "Could not load providers: boom",
    );
    expect(translate("zh-CN", "pickerKnownNote", { label: "X" })).toBe("已为 X 填入命令。");
    // Hints documenting {source}/{target} survive without arguments.
    expect(translate("en", "systemPromptHint")).toContain("{source}");
  });

  it("keeps every locale table in key parity with English", () => {
    expect(PLUGIN_STRING_KEYS.length).toBeGreaterThan(0);
    for (const locale of PLUGIN_LOCALES) {
      expect(pluginLocaleKeys(locale), locale).toEqual(PLUGIN_STRING_KEYS);
      for (const key of PLUGIN_STRING_KEYS) {
        expect(translate(locale, key).length, `${locale}:${key}`).toBeGreaterThan(0);
      }
    }
  });
});
