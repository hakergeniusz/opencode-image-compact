# opencode-image-compact

Turns images into text for models that cannot accept them, so a screenshot is
usable instead of silently disappearing. Native OpenCode V2 plugin; rewritten
from the pi extension `pi-image-compact`.

## The problem

A text-only model drops image input rather than failing: the assistant gets a
filename or a placeholder and no information. This plugin extracts the text
while the image bytes still exist:

- **Local OCR** with `tesseract` — free, deterministic, cached by content hash.
- **Vision fallback** — when OCR finds no text (charts, photos, diagrams), a
  vision-capable OpenCode model describes the image through a nested
  `opencode run` call. It reuses the user's existing OpenCode credentials; no
  API key is read, stored, or forwarded by this plugin.

The result is a text part in place of the image:

```text
[image — /home/you/.local/share/opencode/cache/image-compact/eb49a844ca83324e.png]
The active model cannot accept images, so this image was OCR'd locally (tesseract).
If this is not specific enough, call the inspect_image tool with the path above.
Do not assume it is complete.

...extracted text...
```

The trigger is the selected model's live capabilities (`capabilities.input`
from `ctx.model.list()`), not a model-exemption list. A free tier that
load-balances may disagree with its own catalog; when it says images are
unsupported, converting is still better than losing the image.

## How it maps from the pi original

| pi extension | OpenCode V2 plugin |
|---|---|
| `pi.on("tool_result")` rewriting a read-tool result | `ctx.tool.hook("execute.after")` rewriting a completed tool result's `content` so image file parts never enter history |
| `pi.on("context")` rewriting message content | `ctx.session.hook("context")` (plus `generate` and `compaction`, which pi covered with one hook) rewriting `event.messages` media parts |
| `pi.registerTool({ name: "inspect_image", parameters: Type.Object(...) })` | `ctx.tool.transform` with `editor.add({ name, input: JSON Schema, execute })` |
| `ctx.model.input` at call time | `ctx.model.list()` → `Model.Info.capabilities.input` for `event.model` |
| nested `pi -p ... --no-extensions` child | nested `opencode run --model … --file … --auto --archived` with `OPENCODE_IMAGE_COMPACT_CHILD=1` so this plugin does not load in the child and recurse |
| `PI_IMAGE_COMPACT_*` env vars | `ctx.options` from the `plugins` object form, with the old env vars kept as fallbacks |
| `~/.pi/agent/cache/image-compact/` | `$XDG_DATA_HOME/opencode/cache/image-compact/` (default `~/.local/share/opencode/cache/image-compact/`) |

`inspect_image` still runs sparse-text OCR (`--psm 11`) first and only asks
the vision model when that comes back empty. It is always registered; pi's
`exposure: "deferred"` has no V2 equivalent (see gaps).

## Load

Add it to `opencode.json(c)` (global or project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-image-compact",
      "options": {
        "visionModel": "provider/model"
      }
    },
  ],
}
```

For a local checkout, use the directory path instead of the package name:

```jsonc
"plugins": [{ "package": "/home/you/Projects/opencode-image-compact", "options": {} }]
```

Config changes reload without a restart; force one with `/reload` if needed.
`opencode service restart` is only for a stuck service, not for plugin changes.

## Options

Options come from `ctx.options`; every key also has an environment fallback
(the legacy `PI_IMAGE_COMPACT_*` names still work).

| Option | Env fallback | Default | Purpose |
|---|---|---|---|
| `visionModel` | `OPENCODE_IMAGE_COMPACT_MODEL`, `PI_IMAGE_COMPACT_MODEL` | first enabled image-capable model from `ctx.model.list()` | `provider/model` used by the vision fallback and `inspect_image` |
| `force` | `OPENCODE_IMAGE_COMPACT_FORCE`, `PI_IMAGE_COMPACT_FORCE` | `false` | `true` converts even when the model declares image input |
| `timeoutMs` | `OPENCODE_IMAGE_COMPACT_TIMEOUT_MS`, `PI_IMAGE_COMPACT_TIMEOUT_MS` | `120000` | per-image OCR / child-call timeout |
| `ocr` | `OPENCODE_IMAGE_COMPACT_OCR`, `PI_IMAGE_COMPACT_OCR` | `true` | `false` skips OCR and always uses the vision model |
| `ocrPsm` | `OPENCODE_IMAGE_COMPACT_OCR_PSM`, `PI_IMAGE_COMPACT_OCR_PSM` | `3` | tesseract PSM for the main pass |
| `ocrPsmSparse` | `OPENCODE_IMAGE_COMPACT_OCR_PSM_SPARSE`, `PI_IMAGE_COMPACT_OCR_PSM_SPARSE` | `11` | tesseract PSM for `inspect_image` |
| `cacheDir` | `OPENCODE_IMAGE_COMPACT_CACHE_DIR` | `<opencode cache>/image-compact` | where image bytes and descriptions are cached |
| `bin` | `OPENCODE_IMAGE_COMPACT_BIN` | `opencode` | executable used for the nested vision call |

`tesseract` must be on `PATH` for OCR. If it is missing or finds no text, the
plugin falls back to the vision model.

## Known gaps / differences from pi

- **Tool exposure.** pi's deferred `inspect_image` (found via `tool_search`)
  has no V2 equivalent. The tool is registered normally with `codemode: true`,
  so it is visible in the tool list and available in Code Mode.
- **Hook coverage.** `context` runs for the agent loop, not for every request;
  the plugin also registers `generate` and `compaction`. Titles are not
  converted (they have no images in practice).
- **Model on tool results.** The `execute.after` hook has no model field, so
  it checks the session's selected model via `ctx.session.get`; the context
  hook uses the exact request model. A per-request model override could make
  these disagree.
- **Child configuration.** pi's `PI_IMAGE_COMPACT_CHILD_EXTENSIONS` and
  `PI_IMAGE_COMPACT_CHILD_TOOLS` do not apply. The nested `opencode run` uses
  the user's normal OpenCode config, agents, and auth; `--auto` approves
  permissions and the marker env var prevents plugin recursion.
- **Part shapes.** Conversion targets OpenCode's lowered `media` parts, tool
  `file` parts, and API-shaped user `files`; provider-specific image encodings
  introduced by another plugin after this hook are out of scope.
- **Tests.** The original had no test files, so none were ported.

MIT. Copyright 2026 hakergeniusz.
