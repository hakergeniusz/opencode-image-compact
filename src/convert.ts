/**
 * Image → text conversion core for the OpenCode plugin.
 *
 * A text-only model loses images: the bytes are dropped before it can use
 * them. This module replaces an image with text while the bytes still exist:
 * local OCR via tesseract first, then (when OCR finds nothing) a description
 * from a vision-capable OpenCode model. Descriptions are cached by content
 * hash so a screenshot costs one OCR run / one model call ever.
 *
 * The vision fallback launches a nested `opencode run` call with a marker
 * environment variable that prevents this plugin from loading in the child and
 * recursing.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

export interface Settings {
  /** `provider/model` used for the vision fallback. Auto-detected when unset. */
  visionModel?: string
  /** Convert even when the active model claims image support. */
  force: boolean
  timeoutMs: number
  ocrEnabled: boolean
  ocrPsm: string
  ocrPsmSparse: string
  cacheDir: string
  bin: string
}

type UnknownRecord = Record<string, unknown>

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

function bool(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value !== 0
  if (typeof value === "string") {
    const v = value.trim().toLowerCase()
    if (v === "1" || v === "true" || v === "yes") return true
    if (v === "0" || v === "false" || v === "no") return false
  }
  return undefined
}

function num(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(str(value))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** Choose the first explicitly supplied value: plugin option, then env vars. */
function pick(options: UnknownRecord, key: string, envs: string[]): unknown {
  const fromOptions = options[key]
  if (fromOptions !== undefined && fromOptions !== null && fromOptions !== "") return fromOptions
  for (const name of envs) {
    const raw = process.env[name]
    if (raw !== undefined && raw.trim() !== "") return raw
  }
  return undefined
}

export function resolveSettings(options: UnknownRecord = {}): Settings {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share")
  const defaultCacheDir = join(dataHome, "opencode", "cache", "image-compact")
  return {
    visionModel: str(pick(options, "visionModel", ["OPENCODE_IMAGE_COMPACT_MODEL"])),
    force: bool(pick(options, "force", ["OPENCODE_IMAGE_COMPACT_FORCE"])) ?? false,
    timeoutMs: num(pick(options, "timeoutMs", ["OPENCODE_IMAGE_COMPACT_TIMEOUT_MS"])) ?? 120_000,
    ocrEnabled: bool(pick(options, "ocr", ["OPENCODE_IMAGE_COMPACT_OCR"])) ?? true,
    ocrPsm: str(pick(options, "ocrPsm", ["OPENCODE_IMAGE_COMPACT_OCR_PSM"])) ?? "3",
    ocrPsmSparse: str(pick(options, "ocrPsmSparse", ["OPENCODE_IMAGE_COMPACT_OCR_PSM_SPARSE"])) ?? "11",
    cacheDir: str(pick(options, "cacheDir", ["OPENCODE_IMAGE_COMPACT_CACHE_DIR"])) ?? defaultCacheDir,
    bin: str(pick(options, "bin", ["OPENCODE_IMAGE_COMPACT_BIN"])) ?? "opencode",
  }
}

/**
 * Asked of the vision model. A reader who has never seen the screen needs
 * verbatim text and spatial layout, not a mood or a guess at intent.
 */
export const DESCRIBE_PROMPT = [
  "Read the attached image and write a description for an assistant that cannot see images.",
  "Include, in this order:",
  "1. Every piece of visible text, transcribed exactly, keeping line breaks, in a fenced block.",
  "2. What kind of screen this is and what state it is in.",
  "3. Layout and spatial relationships: what is where, what is selected, what is highlighted.",
  "4. Colours, and any red/error/green/success colouring that carries meaning.",
  "Be literal. Do not speculate about intent and do not advise what to do about it.",
].join("\n")

const UNAVAILABLE = "[image description unavailable"

interface TextBlock {
  type: "text"
  text: string
}
interface ImageBlock {
  data: string
  mimeType: string
}
type Via = "ocr" | "vision"

export interface Description {
  text: string
  file: string
  via: Via
}

function hashOf(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

function extFor(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
  }
  return map[mimeType.toLowerCase()] ?? ".png"
}

export function isImageMime(mime: unknown): mime is string {
  return typeof mime === "string" && /^image\//i.test(mime)
}

/** Put the bytes on disk so the child CLI can attach them, and OCR has a path. */
function materialise(image: ImageBlock, key: string, cacheDir: string): string {
  mkdirSync(cacheDir, { recursive: true })
  const file = join(cacheDir, `${key}${extFor(image.mimeType)}`)
  if (!existsSync(file)) writeFileSync(file, Buffer.from(image.data, "base64"))
  return file
}

function cachedDescription(key: string, cacheDir: string): string | undefined {
  const file = join(cacheDir, `${key}.txt`)
  if (!existsSync(file)) return undefined
  try {
    return readFileSync(file, "utf8").trim() || undefined
  } catch {
    return undefined
  }
}

function cacheDescription(key: string, text: string, cacheDir: string): void {
  try {
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, `${key}.txt`), text)
  } catch {
    // a cache miss next time is not worth failing a request over
  }
}

/** Run one nested OpenCode turn that attaches the image and describes it. */
function describeWithVisionModel(
  imagePath: string,
  prompt: string,
  settings: Settings,
  model?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!model) {
    return Promise.resolve(
      `${UNAVAILABLE}: no vision model is configured or available (set "visionModel" or OPENCODE_IMAGE_COMPACT_MODEL)`,
    )
  }
  return new Promise((resolve) => {
    const args = [
      "run",
      "--model",
      model,
      "--file",
      imagePath,
      "--auto",
      "--archived",
      "--title",
      "image-compact vision",
      `${prompt}\n\nImage path: ${imagePath}`,
    ]
    let settled = false
    const done = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(settings.bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCODE_IMAGE_COMPACT_CHILD: "1" },
      signal,
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), settings.timeoutMs)
    let out = ""
    let err = ""
    child.stdout.on("data", (d) => {
      out += String(d)
    })
    child.stderr.on("data", (d) => {
      err += String(d)
    })
    child.on("error", (e) => {
      done(`${UNAVAILABLE}: could not run the vision model (${String(e)})`)
    })
    child.on("close", (code) => {
      const text = out
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        // eslint-disable-next-line no-control-regex
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
        .trim()
      if (text) done(text)
      else if (code === 0) done(`${UNAVAILABLE}: the vision model returned nothing`)
      else done(`${UNAVAILABLE}: the vision model failed (exit ${code}). ${err.trim().slice(0, 200)}`)
    })
  })
}

/** OCR one image with tesseract. "" means missing, failed, or no readable text. */
function ocrImage(imagePath: string, psm: string, settings: Settings, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const child = spawn("tesseract", [imagePath, "stdout", "-l", "eng", "--psm", psm], {
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), settings.timeoutMs)
    let out = ""
    child.stdout.on("data", (d) => {
      out += String(d)
    })
    child.on("error", () => done(""))
    child.on("close", () => {
      done(out.replace(/\f/g, "").replace(/\n{3,}/g, "\n\n").trim())
    })
  })
}

/** One image, converted for a text-only model: OCR first, vision as fallback. */
export async function describeImage(
  image: ImageBlock,
  settings: Settings,
  opts: { prompt?: string; psm?: string; model?: string; signal?: AbortSignal } = {},
): Promise<Description> {
  const prompt = opts.prompt ?? DESCRIBE_PROMPT
  const key = hashOf(image.data)
  let file: string
  try {
    file = materialise(image, key, settings.cacheDir)
  } catch (e) {
    return {
      text: `${UNAVAILABLE}: could not write the image to disk (${String(e)})]`,
      file: "",
      via: "ocr",
    }
  }

  if (settings.ocrEnabled) {
    // Key on the mode so OCR results never collide with cached vision descriptions.
    const psm = opts.psm ?? settings.ocrPsm
    const ocrKey = hashOf(`ocr:psm${psm}\x00${image.data}`)
    const hit = cachedDescription(ocrKey, settings.cacheDir)
    if (hit) return { text: hit, file, via: "ocr" }
    const ocr = await ocrImage(file, psm, settings, opts.signal)
    if (ocr) {
      cacheDescription(ocrKey, ocr, settings.cacheDir)
      return { text: ocr, file, via: "ocr" }
    }
  }

  // OCR found nothing (or is disabled): charts, photos and diagrams still carry
  // information a text-only model can use, so describe them with a vision model.
  const visionKey = hashOf(`${prompt}\x00${image.data}`)
  const visionHit = cachedDescription(visionKey, settings.cacheDir)
  if (visionHit) return { text: visionHit, file, via: "vision" }
  const text = await describeWithVisionModel(file, prompt, settings, opts.model, opts.signal)
  if (!text.startsWith(UNAVAILABLE)) cacheDescription(visionKey, text, settings.cacheDir)
  return { text, file, via: "vision" }
}

/** `inspect_image`: sparse OCR first, then a focused vision description. */
export async function inspectImage(
  path: string,
  focus: string | undefined,
  settings: Settings,
  model: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  if (!existsSync(path)) return `No such file: ${path}`
  let data: string
  try {
    data = readFileSync(path).toString("base64")
  } catch (e) {
    return `Could not read ${path}: ${String(e)}`
  }
  const prompt = focus?.trim()
    ? `${DESCRIBE_PROMPT}\n\nThis time, focus on: ${focus.trim()}. Be exhaustive about it.`
    : DESCRIBE_PROMPT

  if (settings.ocrEnabled) {
    const sparseKey = hashOf(`ocr:psm${settings.ocrPsmSparse}\x00${data}`)
    const hit = cachedDescription(sparseKey, settings.cacheDir)
    if (hit) return hit
    const ocr = await ocrImage(path, settings.ocrPsmSparse, settings, signal)
    if (ocr) {
      cacheDescription(sparseKey, ocr, settings.cacheDir)
      return ocr
    }
  }

  const visionKey = hashOf(`${prompt}\x00${data}`)
  const hit = cachedDescription(visionKey, settings.cacheDir)
  if (hit) return hit
  const text = await describeWithVisionModel(path, prompt, settings, model, signal)
  if (!text.startsWith(UNAVAILABLE)) cacheDescription(visionKey, text, settings.cacheDir)
  return text
}

export function renderBlock(index: number, count: number, description: Description): string {
  const which = count > 1 ? ` ${index + 1} of ${count}` : ""
  const origin =
    description.via === "ocr"
      ? "The active model cannot accept images, so this image was OCR'd locally (tesseract)."
      : "The active model cannot accept images, and OCR found no text, so a vision model described this one instead."
  return [
    `[image${which} — ${description.file}]`,
    origin,
    "If this is not specific enough, call the inspect_image tool with the path above.",
    "Do not assume it is complete.",
    "",
    description.text.trim(),
  ].join("\n")
}

/** Extract image bytes from the part shapes OpenCode actually uses. */
function imageFrom(part: unknown): ImageBlock | undefined {
  if (!part || typeof part !== "object") return undefined
  const p = part as UnknownRecord

  // Generic image blocks kept for defensive compatibility.
  if (p.type === "image" && typeof p.data === "string") {
    return { data: p.data, mimeType: str(p.mimeType) ?? str(p.mime) ?? "image/png" }
  }

  // OpenCode lowered message media part.
  if (p.type === "media" && p.media && typeof p.media === "object") {
    const media = p.media as UnknownRecord
    const source = media.source as UnknownRecord | undefined
    const hint = str(source?.mediaType) ?? str(media.mediaType)
    if (source?.type === "base64" && typeof source.data === "string") {
      return { data: source.data, mimeType: hint ?? "image/png" }
    }
    if (source?.type === "url" && typeof source.url === "string") {
      return imageFromUri(source.url, hint)
    }
    if (source?.type === "bytes") {
      const bytes = source.data
      if (bytes instanceof Uint8Array) {
        return { data: Buffer.from(bytes).toString("base64"), mimeType: hint ?? "image/png" }
      }
    }
  }

  // Tool file content and OpenCode user file attachments.
  if (typeof p.uri === "string") return imageFromUri(p.uri, str(p.mime) ?? str(p.mediaType))
  if (typeof p.data === "string" && (isImageMime(p.mime) || isImageMime(p.mediaType))) {
    return { data: p.data, mimeType: str(p.mime) ?? str(p.mediaType) ?? "image/png" }
  }
  if (typeof p.path === "string" && existsSync(p.path)) {
    return { data: readFileSync(p.path).toString("base64"), mimeType: str(p.mime) ?? "image/png" }
  }
  return undefined
}

function imageFromUri(uri: string, hint?: string): ImageBlock | undefined {
  if (uri.startsWith("data:")) {
    const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(uri)
    if (!match) return undefined
    const mimeType = match[1] || hint || "image/png"
    if (!isImageMime(mimeType)) return undefined
    const data = match[2]
      ? match[3]
      : Buffer.from(decodeURIComponent(match[3]), "utf8").toString("base64")
    return { data, mimeType }
  }
  if (uri.startsWith("file://")) {
    const path = fileURLToPath(uri)
    if (!existsSync(path)) return undefined
    return { data: readFileSync(path).toString("base64"), mimeType: hint ?? "image/png" }
  }
  if (existsSync(uri)) {
    return { data: readFileSync(uri).toString("base64"), mimeType: hint ?? "image/png" }
  }
  return undefined
}

interface Job {
  image: ImageBlock
  apply: (description: Description, index: number, count: number) => void
}

const NON_VISION_NOTE = "does not support images"

/**
 * Replace image media parts and image tool-result file parts with text parts.
 * Returns `parts` untouched when there was nothing to convert.
 */
export async function convertParts(
  parts: unknown[],
  settings: Settings,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<{ parts: unknown[]; converted: boolean }> {
  const next = parts.slice()
  const jobs: Job[] = []
  const posts: Array<() => void> = []

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    if (!part || typeof part !== "object") continue
    const p = part as UnknownRecord

    // `media` / `image` are message parts; `file` and bare `uri` parts are
    // tool-result content (and API-shaped user attachments).
    if (p.type === "media" || p.type === "image" || p.type === "file" || typeof p.uri === "string") {
      const image = imageFrom(p)
      if (image) {
        jobs.push({
          image,
          apply: (d, index, count) => {
            next[i] = { type: "text", text: renderBlock(index, count, d) } satisfies TextBlock
          },
        })
        continue
      }
    }

    if (p.type === "tool-result" && (p.result as UnknownRecord | undefined)?.type === "content") {
      const result = p.result as UnknownRecord
      const value = result.value
      if (!Array.isArray(value)) continue
      const nextValue = value.slice()
      let convertedHere = 0
      value.forEach((inner, j) => {
        const image = imageFrom(inner)
        if (!image) return
        convertedHere++
        jobs.push({
          image,
          apply: (d, index, count) => {
            nextValue[j] = { type: "text", text: renderBlock(index, count, d) } satisfies TextBlock
          },
        })
      })
      if (convertedHere > 0) {
        posts.push(() => {
          // Remove "does not support images" notes once a description has been supplied.
          const filtered = nextValue.filter((v) => {
            const text = (v as UnknownRecord | undefined)?.text
            return !(typeof text === "string" && text.includes(NON_VISION_NOTE))
          })
          next[i] = { ...p, result: { ...result, value: filtered } }
        })
      }
    }
  }

  if (jobs.length === 0) return { parts, converted: false }
  const descriptions = await Promise.all(jobs.map((job) => describeImage(job.image, settings, opts)))
  jobs.forEach((job, i) => job.apply(descriptions[i], i, jobs.length))
  posts.forEach((post) => post())
  return { parts: next, converted: true }
}

/**
 * Convert images in lowered request messages. Also understands API-shaped user
 * messages with a `files` array, so either representation is covered.
 */
export async function convertMessages(
  messages: unknown[],
  settings: Settings,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<{ messages: unknown[]; touched: boolean }> {
  const next: unknown[] = []
  let touched = false

  for (const message of messages) {
    if (!message || typeof message !== "object") {
      next.push(message)
      continue
    }
    const m = message as UnknownRecord
    if (Array.isArray(m.content)) {
      const result = await convertParts(m.content as unknown[], settings, opts)
      if (result.converted) {
        touched = true
        next.push({ ...m, content: result.parts })
        continue
      }
    }
    if (Array.isArray(m.files)) {
      const files = m.files as unknown[]
      const kept: unknown[] = []
      const descriptions: string[] = []
      for (const file of files) {
        const image = imageFrom(file)
        if (!image || !isImageMime(image.mimeType)) {
          kept.push(file)
          continue
        }
        const d = await describeImage(image, settings, opts)
        descriptions.push(renderBlock(descriptions.length, 1, d))
        touched = true
      }
      if (descriptions.length > 0) {
        const content = Array.isArray(m.content) ? (m.content as unknown[]).slice() : []
        content.push({ type: "text", text: descriptions.join("\n\n") } satisfies TextBlock)
        next.push({ ...m, content, files: kept })
        continue
      }
    }
    next.push(message)
  }

  return { messages: next, touched }
}

/** Rewrite a completed tool result so image file content never enters history. */
export async function convertToolResult(
  result: unknown,
  settings: Settings,
  opts: { model?: string; signal?: AbortSignal } = {},
): Promise<unknown | undefined> {
  if (!result || typeof result !== "object") return undefined
  const r = result as UnknownRecord
  if (!Array.isArray(r.content)) return undefined
  const converted = await convertParts(
    r.content.map((c) => (typeof c === "string" ? { type: "text", text: c } : c)),
    settings,
    opts,
  )
  if (!converted.converted) return undefined
  return { ...r, content: converted.parts }
}

export function modelIdFromRef(ref: unknown): string | undefined {
  if (!ref || typeof ref !== "object") return undefined
  const r = ref as UnknownRecord
  return str(r.modelID) ?? str(r.id)
}
