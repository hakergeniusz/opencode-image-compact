# opencode-image-compact

OpenCode plugin that turns images into text for models that cannot accept image input, so screenshots and other images remain usable instead of being dropped.

## How it works

When the active model does not declare image support, the plugin extracts text from images while their bytes are still available:

- **Local OCR** with `tesseract` — fast, deterministic, cached by content hash.
- **Vision fallback** — when OCR finds no text (charts, photos, diagrams), a vision-capable OpenCode model describes the image through a nested `opencode run` call. It reuses the user's existing OpenCode configuration and credentials; this plugin does not read, store, or forward API keys.

Converted images are replaced with a text part that includes the source, extraction method, and the extracted content:

```text
[image — /home/you/.local/share/opencode/cache/image-compact/eb49a844ca83324e.png]
The active model cannot accept images, so this image was OCR'd locally (tesseract).
If this is not specific enough, call the inspect_image tool with the path above.
Do not assume it is complete.

...extracted text...
```

Conversion is triggered from the selected model's live capabilities (`capabilities.input` from `ctx.model.list()`), not from a hardcoded model list. Set `force` to convert even when a model declares image input.

## Features

- **Request conversion**: rewrites image media parts in session hooks (`context`, `generate`, `compaction`) so text-only models receive descriptions instead of dropped images.
- **Tool result conversion**: rewrites completed tool results so image file content does not enter persisted history for text-only models.
- **`inspect_image` tool**: re-extracts an image with sparse-text OCR (`--psm 11` by default). If OCR still finds nothing, it can produce a focused vision description when `focus` is provided.
- **Caching**: OCR and vision descriptions are cached by content hash under the configured cache directory.
- **Recursion guard**: nested vision fallback runs set `OPENCODE_IMAGE_COMPACT_CHILD=1` so the plugin does not load in the child process.

## Load

Add it to `opencode.json` or `opencode.jsonc` (global or project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-image-compact",
      "options": {
        "visionModel": "provider/model"
      }
    }
  ]
}
```

For a local checkout, use the directory path instead of the package name:

```jsonc
{
  "plugins": [{ "package": "/home/you/Projects/opencode-image-compact", "options": {} }]
}
```

Config changes reload without a restart; force one with `/reload` if needed.

## Options

Options come from plugin `options`; each key also has an `OPENCODE_IMAGE_COMPACT_*` environment variable fallback.

| Option | Environment variable | Default | Purpose |
|---|---|---|---|
| `visionModel` | `OPENCODE_IMAGE_COMPACT_MODEL` | first enabled image-capable model from `ctx.model.list()` | `provider/model` used by the vision fallback and `inspect_image` |
| `force` | `OPENCODE_IMAGE_COMPACT_FORCE` | `false` | Convert even when the model declares image input |
| `timeoutMs` | `OPENCODE_IMAGE_COMPACT_TIMEOUT_MS` | `120000` | Per-image OCR / vision-call timeout (ms) |
| `ocr` | `OPENCODE_IMAGE_COMPACT_OCR` | `true` | Set to `false` to skip OCR and always use the vision model |
| `ocrPsm` | `OPENCODE_IMAGE_COMPACT_OCR_PSM` | `3` | Tesseract page segmentation mode for the main OCR pass |
| `ocrPsmSparse` | `OPENCODE_IMAGE_COMPACT_OCR_PSM_SPARSE` | `11` | Tesseract page segmentation mode for `inspect_image` |
| `cacheDir` | `OPENCODE_IMAGE_COMPACT_CACHE_DIR` | `$XDG_DATA_HOME/opencode/cache/image-compact` (default `~/.local/share/opencode/cache/image-compact`) | Directory for cached image bytes and descriptions |
| `bin` | `OPENCODE_IMAGE_COMPACT_BIN` | `opencode` | Executable used for nested vision fallback calls |

`tesseract` must be on `PATH` for OCR. If it is missing or finds no text, the plugin falls back to the vision model (when configured or auto-detected).

## Notes

- **Hook coverage**: request conversion runs in `context`, `generate`, and `compaction` hooks to cover common request paths.
- **Model selection**: `execute.after` determines image support from the session's selected model via `ctx.session.get`; request hooks use the request's model reference. Per-request overrides can make these differ.
- **Part shapes**: conversion targets OpenCode `media` parts, tool `file` parts, and API-shaped user `files`. Provider-specific image encodings introduced after these hooks are out of scope.
- **Nested vision calls**: fallback runs `opencode run --model … --file … --auto --archived` using the user's normal OpenCode configuration and auth.

## License

MIT. Copyright 2026 hakergeniusz.
