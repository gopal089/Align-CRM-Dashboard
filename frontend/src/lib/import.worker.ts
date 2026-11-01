import { parseImportFile } from "./importParser";
self.onmessage = (
  event: MessageEvent<{ name: string; bytes: ArrayBuffer }>,
) => {
  try {
    self.postMessage({
      book: parseImportFile(event.data.name, new Uint8Array(event.data.bytes)),
    });
  } catch (error) {
    self.postMessage({
      error:
        error instanceof Error ? error.message : "The file could not be read.",
    });
  }
};
