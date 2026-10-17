import { describe, expect, test } from "bun:test";
import type { ProviderBinding } from "../binding";
import { withSandbox } from "../helpers";

export function filesDomain(binding: ProviderBinding): void {
  describe(`${binding.name}: files`, () => {
    test("write, read, stat, list, move and delete a text file", async () => {
      await withSandbox(binding, "files-text", async (sb) => {
        await sb.createDirectory("/workspace/src");
        await sb.writeFile("/workspace/src/a.txt", "héllo\nworld\n");

        expect(await sb.readFile("/workspace/src/a.txt")).toBe("héllo\nworld\n");

        const info = await sb.getFileInfo("/workspace/src/a.txt");
        expect(info.type).toBe("file");
        expect(info.size).toBeGreaterThan(0);

        const entries = await sb.listDirectory("/workspace/src");
        expect(entries.some((e) => e.path.endsWith("a.txt"))).toBe(true);

        await sb.moveFile("/workspace/src/a.txt", "/workspace/src/b.txt");
        expect(await sb.readFile("/workspace/src/b.txt")).toContain("world");

        await sb.deleteFile("/workspace/src/b.txt");
        const after = await sb.exec("test -e /workspace/src/b.txt && echo yes || echo no");
        expect(after.stdout.trim()).toBe("no");
      });
    });

    test("round-trips binary bytes exactly", async () => {
      await withSandbox(binding, "files-binary", async (sb) => {
        const bytes = new Uint8Array(4096);
        for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256;

        await sb.writeFileBytes("/workspace/blob.bin", bytes);
        const back = await sb.readFileBytes("/workspace/blob.bin");

        expect(back.length).toBe(bytes.length);
        expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
      });
    });

    test("round-trips a 5 MB file", async () => {
      await withSandbox(binding, "files-large", async (sb) => {
        const size = 5 * 1024 * 1024;
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i += 7) bytes[i] = (i / 7) % 251;

        await sb.writeFileBytes("/workspace/large.bin", bytes);
        const back = await sb.readFileBytes("/workspace/large.bin");

        expect(back.length).toBe(size);
        expect(Buffer.from(back).equals(Buffer.from(bytes))).toBe(true);
      });
    });

    test("a file written by a command is readable through the file API", async () => {
      await withSandbox(binding, "files-cross", async (sb) => {
        await sb.exec("printf 'from-shell' > /workspace/shell.txt");
        expect(await sb.readFile("/workspace/shell.txt")).toBe("from-shell");
      });
    });
  });
}
