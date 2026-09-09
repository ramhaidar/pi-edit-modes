import { createReadStream } from "node:fs";

export interface StreamReadOptions {
  offset: number;
  limit: number;
  maxBytes: number;
  maxLineLength: number;
  binarySampleBytes: number;
  signal?: AbortSignal;
}

export interface StreamReadWindow {
  lines: Array<{ number: number; text: string }>;
  totalLines: number;
  truncatedByBytes: boolean;
}

export class StreamReadError extends Error {
  readonly kind: "binary" | "utf8" | "aborted" | "range";

  constructor(
    message: string,
    kind: "binary" | "utf8" | "aborted" | "range",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "StreamReadError";
    this.kind = kind;
  }
}

export async function readTextWindowFromChunkProducer(
  produce: (consume: (chunk: Buffer) => void | Promise<void>) => Promise<void>,
  options: StreamReadOptions,
): Promise<StreamReadWindow> {
  const selected: Array<{ number: number; text: string }> = [];
  let totalLines = 0;
  let outputBytes = 0;
  let truncatedByBytes = false;
  let sampleRemaining = options.binarySampleBytes;
  let currentLine = "";
  let lineOverflow = false;
  let lineOpen = false;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const append = (fragment: string) => {
    if (fragment.length > 0) lineOpen = true;
    const keptLimit = options.maxLineLength + 1;
    if (currentLine.length >= keptLimit) {
      if (fragment.length > 0) lineOverflow = true;
      return;
    }
    const remaining = keptLimit - currentLine.length;
    currentLine += fragment.slice(0, remaining);
    if (fragment.length > remaining) lineOverflow = true;
  };

  const finishLine = () => {
    totalLines += 1;
    let raw = currentLine.endsWith("\r") ? currentLine.slice(0, -1) : currentLine;
    const wasTruncated = lineOverflow || raw.length > options.maxLineLength;
    if (raw.length > options.maxLineLength) raw = raw.slice(0, options.maxLineLength);
    const text = wasTruncated
      ? `${raw}... (line truncated to ${options.maxLineLength} chars)`
      : raw;
    if (totalLines >= options.offset && selected.length < options.limit && !truncatedByBytes) {
      const cost = Buffer.byteLength(text, "utf8") + (selected.length > 0 ? 1 : 0);
      if (outputBytes + cost > options.maxBytes) truncatedByBytes = true;
      else {
        outputBytes += cost;
        selected.push({ number: totalLines, text });
      }
    }
    currentLine = "";
    lineOverflow = false;
    lineOpen = false;
  };

  const consume = (chunk: Buffer) => {
    if (options.signal?.aborted) throw new StreamReadError("read aborted", "aborted");
    if (sampleRemaining > 0) {
      const sample = chunk.subarray(0, sampleRemaining);
      if (sample.includes(0)) throw new StreamReadError("binary file", "binary");
      sampleRemaining -= sample.length;
    }
    let text = decoder.decode(chunk, { stream: true });
    while (text.length > 0) {
      const newline = text.indexOf("\n");
      if (newline < 0) {
        append(text);
        break;
      }
      append(text.slice(0, newline));
      finishLine();
      text = text.slice(newline + 1);
    }
  };

  try {
    await produce(consume);
    const tail = decoder.decode();
    if (tail.length > 0) append(tail);
    if (lineOpen) finishLine();
  } catch (error) {
    if (error instanceof StreamReadError) throw error;
    if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
      throw new StreamReadError("read aborted", "aborted", { cause: error });
    }
    if (error instanceof TypeError)
      throw new StreamReadError("invalid UTF-8 text", "utf8", { cause: error });
    throw error;
  }

  if (options.offset > totalLines && !(totalLines === 0 && options.offset === 1)) {
    throw new StreamReadError(
      `offset ${options.offset} is out of range (${totalLines} lines)`,
      "range",
    );
  }
  return { lines: selected, totalLines, truncatedByBytes };
}

export async function readTextWindowStreaming(
  path: string,
  options: StreamReadOptions,
): Promise<StreamReadWindow> {
  return readTextWindowFromChunkProducer(async (consume) => {
    const stream = createReadStream(path, options.signal ? { signal: options.signal } : undefined);
    for await (const rawChunk of stream) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      await consume(chunk);
    }
  }, options);
}
