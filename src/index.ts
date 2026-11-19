/**
 * opencode-image-compact — make images usable by models that cannot see them.
 *
 * Converted where the bytes still exist: request hooks (context / generate /
 * compaction) and the tool execute.after hook. Primary conversion is local
 * OCR (tesseract); when OCR finds no text a vision model describes the image
 * through a nested, non-recursive `opencode run` call. `inspect_image` offers a
 * sparse-OCR / focused-vision second pass.
 */
import { Plugin } from "@opencode/plugin"
import { convertMessages, convertToolResult, inspectImage, modelIdFromRef, resolveSettings } from "./convert.js"

type UnknownRecord = Record<string, unknown>

interface ModelRef {
  providerID?: string
  id?: string
  modelID?: string
}

interface RequestEvent {
  sessionID?: string
  model?: ModelRef
  messages: unknown[]
}

interface ToolResultEvent {
  sessionID?: string
  status: "completed" | "error"
  result?: unknown
}

export default Plugin.define({
  id: "opencode-image-compact",
  async setup(ctx) {
    // The nested `opencode run` child sets this marker. It prevents this
    // plugin (and its hooks) from loading in the child and recursing.
    if (process.env.OPENCODE_IMAGE_COMPACT_CHILD === "1") return

    const options = (ctx.options ?? {}) as UnknownRecord
    const settings = resolveSettings(options)

    async function availableModels(): Promise<UnknownRecord[]> {
      try {
        const listed = (await ctx.model.list()) as unknown
        if (Array.isArray(listed)) return listed as UnknownRecord[]
        if (listed && typeof listed === "object") {
          const r = listed as UnknownRecord
          if (Array.isArray(r.models)) return r.models as UnknownRecord[]
          if (Array.isArray(r.data)) return r.data as UnknownRecord[]
        }
      } catch {
        // handled by callers as an empty registry
      }
      return []
    }

    /** Model capability from the live registry, mirroring pi's `ctx.model.input`. */
    async function modelSeesImages(ref: ModelRef | undefined): Promise<boolean> {
      if (settings.force) return false
      const modelID = modelIdFromRef(ref)
      if (!ref?.providerID || !modelID) return true
      try {
        const models = await availableModels()
        const found = models.find((m) => {
          const providerID = typeof m.providerID === "string" ? m.providerID : undefined
          const id = modelIdFromRef(m)
          return providerID === ref.providerID && (id === modelID || m.id === modelID)
        })
        const capabilities = found?.capabilities as UnknownRecord | undefined
        const input = capabilities?.input
        if (!Array.isArray(input)) return true
        return (input as unknown[]).includes("image")
      } catch {
        // Unknown model: leave the request alone rather than guessing.
        return true
      }
    }

    function modelString(ref: ModelRef | undefined): string | undefined {
      if (!ref?.providerID) return undefined
      const id = modelIdFromRef(ref)
      return id ? `${ref.providerID}/${id}` : undefined
    }

    async function visionModelString(): Promise<string | undefined> {
      if (settings.visionModel) return settings.visionModel
      try {
        const models = await availableModels()
        const candidate = models.find((m) => {
          const capabilities = m.capabilities as UnknownRecord | undefined
          const input = capabilities?.input
          return (
            m.enabled !== false &&
            Array.isArray(input) &&
            (input as unknown[]).includes("image") &&
            typeof m.providerID === "string" &&
            Boolean(modelIdFromRef(m))
          )
        })
        if (candidate) return modelString(candidate as ModelRef)
      } catch {
        // fall through to the explicit-configuration hint
      }
      return undefined
    }

    async function convertRequest(event: RequestEvent): Promise<void> {
      if (await modelSeesImages(event.model)) return
      const result = await convertMessages(event.messages, settings, { model: await visionModelString() })
      if (!result.touched) return
      event.messages.splice(0, event.messages.length, ...result.messages)
    }

    for (const kind of ["context", "generate", "compaction"] as const) {
      await ctx.session.hook(kind, (event) => convertRequest(event as unknown as RequestEvent))
    }

    // Keep images out of persisted tool results, like pi's `tool_result` hook.
    await ctx.tool.hook("execute.after", async (event) => {
      const e = event as unknown as ToolResultEvent
      if (e.status !== "completed" || e.result === undefined) return
      let ref: ModelRef | undefined
      try {
        const fetched = (await ctx.session.get({ sessionID: e.sessionID! })) as UnknownRecord | undefined
        const session = (fetched?.data as UnknownRecord | undefined) ?? fetched
        ref = session?.model as ModelRef | undefined
      } catch {
        ref = undefined
      }
      if (await modelSeesImages(ref)) return
      const converted = await convertToolResult(e.result, settings, { model: await visionModelString() })
      if (converted !== undefined) (event as { result?: unknown }).result = converted
    })

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "inspect_image",
        description:
          "Re-extract an image's text with local OCR in sparse-text mode (finds scattered UI text the first " +
          "pass may have missed). Use this when an image's transcription was not specific enough — pass a focus " +
          "such as \"the error dialog in the top right\" to steer the fallback vision description when OCR " +
          "finds nothing. Works even though the active model cannot see images itself.",
        input: {
          type: "object",
          properties: {
            path: { type: "string", description: "Image path, as given in the description marker." },
            focus: { type: "string", description: "What to look at, if only part of it matters." },
          },
          required: ["path"],
          additionalProperties: false,
        },
        options: { codemode: true },
        async execute(input, context) {
          const args = input as { path?: string; focus?: string }
          const path = typeof args.path === "string" ? args.path : ""
          if (!path) return { content: "inspect_image needs a `path`." }
          const text = await inspectImage(path, args.focus, settings, await visionModelString(), context.signal)
          return { content: text }
        },
      })
    })

  },
})
