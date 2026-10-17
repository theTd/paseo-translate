# Provider icons

Claude and Codex retain the vector paths used by Paseo's native provider icons
(`packages/app/assets/icons/claude.svg` and `codex.svg` in Paseo 0.11.2).
The generic ACP wrapper uses Paseo's Lucide Bot fallback (ISC license).
All three carry the plugin's translation glyph in a blue badge at the bottom right.
The base paths use `currentColor` to follow the host theme.

The ACP wrapper has no fixed upstream provider identity, so its generic agent
icon remains stable when the inner ACP command changes.
