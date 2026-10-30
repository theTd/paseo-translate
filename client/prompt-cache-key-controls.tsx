import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useRpc,
  useSettings,
  type PluginButtonContentProps,
  type PluginButtonIconProps,
  type PluginButtonRegistration,
  type PluginClientContext,
} from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput } from "@getpaseo/plugin/client/ui";
import {
  promptCacheKeySetRpc,
  promptCacheKeyStatusRpc,
  promptCacheKeyValueSchema,
} from "../shared/prompt-cache-key";
import { TRANSLATE_PROVIDER_IDS, translateSettings } from "../shared/translate";
import { observeAgentList, type ObservedAgent } from "./agent-list-observer";
import { useTranslate } from "./i18n";

type PromptCacheKeyStatus = { key: string; pinned: boolean; derived: string };

/**
 * Copy for the pill title. The pill registration happens outside React, so
 * the locale is resolved once from the stored setting (the popover body
 * follows the setting reactively).
 */
function useCopy() {
  const settings = useSettings(translateSettings);
  return useTranslate(settings.status === "ready" ? settings.values.uiLanguage : "system");
}

function usePromptCacheKey(sessionKey: string) {
  const read = useRpc(promptCacheKeyStatusRpc);
  return useQuery({
    queryKey: ["translate-prompt-cache-key", sessionKey],
    queryFn: () => read({ sessionKey }),
    enabled: sessionKey.length > 0,
    // The key only changes through this plugin's own mutations; refetching it
    // on an interval would poll the daemon for nothing.
    staleTime: Infinity,
  });
}

/**
 * Popover body: shows the key the session's next translation request carries
 * and lets the user pin a label, rotate to a fresh key, or hand control back
 * to the plugin.
 *
 * Rotation is deliberately a separate action from editing: pinning a readable
 * label is the usual case, and "new key" is the escape hatch for a gateway
 * whose cache is stuck on a stale prefix. Neither touches the session
 * transcript or the translation cache — only which endpoint cache namespace
 * future requests land in.
 */
function PromptCacheKeyPopover(props: PluginButtonContentProps) {
  const { t } = useCopy();
  const sessionKey = props.context === "agent" ? props.agentId : "";
  const status = usePromptCacheKey(sessionKey);
  const setKey = useRpc(promptCacheKeySetRpc);
  const queries = useQueryClient();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const resolved = status.data as PromptCacheKeyStatus | undefined;
  useEffect(() => {
    if (resolved !== undefined && draft.length === 0) setDraft(resolved.key);
  }, [resolved, draft.length]);

  async function apply(action: "derive" | "regenerate" | { key: string }) {
    if (busy || sessionKey.length === 0) return;
    setBusy(true);
    setMessage("");
    try {
      const next = await setKey({ sessionKey, action });
      queries.setQueryData(["translate-prompt-cache-key", sessionKey], next);
      setDraft(next.key);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function pin() {
    const parsed = promptCacheKeyValueSchema.safeParse(draft);
    if (!parsed.success) {
      setMessage(t("promptCacheKeyInvalid"));
      return;
    }
    void apply({ key: parsed.data });
  }

  const foreground = props.theme.colors.foreground;
  const muted = props.theme.colors.foregroundMuted;
  if (sessionKey.length === 0) {
    return <Text style={{ color: muted }}>{t("promptCacheKeyHint")}</Text>;
  }
  if (status.isPending) return <Text style={{ color: muted }}>{t("loadingSettings")}</Text>;
  if (status.isError) {
    return <Text style={{ color: muted }}>{t("translationUnavailable", {
      error: status.error instanceof Error ? status.error.message : t("translationFailedWord"),
    })}</Text>;
  }
  return (
    <View style={{ padding: 12, gap: 8 }}>
      <Text style={{ color: foreground }}>
        {t("promptCacheKey")}: {resolved?.pinned === true ? t("promptCacheKeyPinned") : t("promptCacheKeyDerived")}
      </Text>
      <Text selectable style={{ color: muted, fontFamily: "monospace" }}>
        {resolved?.key ?? ""}
      </Text>
      <SettingsCard>
        <SettingsInput
          label={t("promptCacheKey")}
          hint={t("promptCacheKeyHint")}
          initialValue={resolved?.key ?? ""}
          onChangeText={setDraft}
          disabled={busy}
        />
        <SettingsAction
          label={t("promptCacheKeySection")}
          actionLabel={t("promptCacheKeySave")}
          onPress={pin}
          disabled={busy}
        />
        <SettingsAction
          label={t("promptCacheKeySection")}
          actionLabel={t("promptCacheKeyRegenerate")}
          onPress={() => { void apply("regenerate"); }}
          disabled={busy}
        />
        <SettingsAction
          label={t("promptCacheKeySection")}
          actionLabel={t("promptCacheKeyReset")}
          onPress={() => { void apply("derive"); }}
          disabled={busy || resolved?.pinned !== true}
        />
      </SettingsCard>
      {message.length > 0 ? <Text accessibilityRole="alert" style={{ color: foreground }}>{message}</Text> : null}
    </View>
  );
}

/** Icon text: a short marker so the pill is distinguishable at a glance. */
function PromptCacheKeyIcon(props: PluginButtonIconProps) {
  return <Text style={{ color: props.color, fontSize: props.size }}>⛁</Text>;
}

/**
 * Registers one composer pill per agent this plugin owns. Mirrors the Claude
 * cache pill: only mounted icons poll, and the registration follows the
 * observed agent list so archived or removed agents drop their pill.
 */
export function contributePromptCacheKeyControls(client: PluginClientContext): () => void {
  const registrations = new Map<string, { workspaceId: string; button: PluginButtonRegistration }>();
  function remove(id: string) {
    registrations.get(id)?.button.remove();
    registrations.delete(id);
  }
  const stop = observeAgentList(client, (agent: ObservedAgent) => {
    if (!(TRANSLATE_PROVIDER_IDS as readonly string[]).includes(agent.provider)) {
      remove(agent.id);
      return;
    }
    if (!agent.workspaceId || agent.archivedAt) {
      remove(agent.id);
      return;
    }
    if (registrations.get(agent.id)?.workspaceId === agent.workspaceId) return;
    remove(agent.id);
    let button: PluginButtonRegistration | undefined;
    button = client.addComposerPill({
      id: "translate-prompt-cache-key",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Prompt cache key",
        label: "⛁",
        icon: PromptCacheKeyIcon,
        behavior: { kind: "popover", Content: PromptCacheKeyPopover },
      },
    });
    registrations.set(agent.id, { workspaceId: agent.workspaceId, button });
  }, remove);
  return () => {
    stop();
    for (const id of registrations.keys()) remove(id);
  };
}