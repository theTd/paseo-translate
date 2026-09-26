import type { ProviderSessionSummary } from "@getpaseo/plugin/server/provider";
import { isSerializedAttachment, restorePromptFragment, translatePromptFragment } from "./prompt-text";
import type { Translator } from "./translate";

/**
 * Titles longer than this stay verbatim without an endpoint call. Real titles
 * are short (Claude truncates to ~200 chars); anything near the shared 100k
 * translation cap must never bill from a history listing.
 */
export const SESSION_TITLE_DISPLAY_LIMIT = 2_000;

/**
 * Most titles translated per ACP `session/list` result frame. Mirrors the
 * direct providers' listing limit; entries past the cap pass through
 * untouched so a hostile inner agent cannot stall the inbound lane or bill
 * one endpoint call per entry without bound.
 */
export const MAX_SESSION_LIST_TITLES_PER_FRAME = 100;

export interface SessionTitleDisplayDeps {
  loadValues(): Promise<{
    translateResponses: boolean;
    userLanguage?: string;
    agentLanguage?: string;
  }>;
  translator: Translator;
}

/**
 * Display-only translation for session-list titles.
 *
 * Stored titles are agent-language text (translated prompts for Claude, the
 * engine's own naming for Codex / inner ACP agents), so they read wrong in a
 * user-language history list. Exact user-language originals recorded at
 * prompt time always win first: no endpoint call, settings-independent, so
 * they restore even when display translation is off, the settings fail to
 * load, or both languages match. Anything else goes through agent-to-user
 * display translation when enabled. Fail soft throughout: per-title failures
 * keep that title, and the listing itself never fails for this.
 */
export async function translateSessionTitlesForDisplay(
  sessions: ProviderSessionSummary[],
  deps: SessionTitleDisplayDeps,
): Promise<ProviderSessionSummary[]> {
  let display = false;
  try {
    const values = await deps.loadValues();
    display =
      values.translateResponses &&
      (values.userLanguage === undefined ||
        values.agentLanguage === undefined ||
        values.userLanguage !== values.agentLanguage);
  } catch {
    display = false;
  }
  // Sequential on purpose: listings are short, and one history open must not
  // burst the endpoint with up to a hundred concurrent translations.
  const out: ProviderSessionSummary[] = [];
  for (const session of sessions) {
    out.push(await restoreAndMaybeTranslate(session, deps.translator, display));
  }
  return out;
}

async function restoreAndMaybeTranslate(
  session: ProviderSessionSummary,
  translator: Translator,
  display: boolean,
): Promise<ProviderSessionSummary> {
  const title = session.title;
  if (title === undefined || title.trim().length === 0) return session;
  if (isSerializedAttachment(title)) return session;
  let restored = title;
  try {
    restored = restorePromptFragment(title, (fragment) => {
      try {
        return translator.restoreOriginalFragment(fragment);
      } catch {
        return undefined;
      }
    });
  } catch {
    restored = title;
  }
  if (restored !== title) return { ...session, title: restored };
  if (!display) return session;
  if (title.length > SESSION_TITLE_DISPLAY_LIMIT) return session;
  try {
    const translated = await translatePromptFragment(title, (fragment) =>
      translator.translate(fragment, "agent-to-user"),
    );
    if (translated.trim().length === 0) return session;
    return { ...session, title: translated };
  } catch {
    return session;
  }
}
