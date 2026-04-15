import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
export async function ensureDir(dirPath) {
    await mkdir(dirPath, { recursive: true });
}
export async function writeTextFile(filePath, content) {
    await ensureDir(path.dirname(filePath));
    await writeFile(filePath, content, "utf8");
}
export async function readJsonFile(filePath) {
    try {
        const contents = await readFile(filePath, "utf8");
        return JSON.parse(contents);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw error;
    }
}
export async function writeJsonFile(filePath, data) {
    await writeTextFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}
