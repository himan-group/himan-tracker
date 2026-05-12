import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function appendJsonlRecord(filePath: string, record: unknown): Promise<void> {
  const serializedRecord = JSON.stringify(record);
  if (serializedRecord === undefined) {
    throw new TypeError("Record cannot be serialized to JSON");
  }

  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await appendFile(filePath, `${serializedRecord}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
