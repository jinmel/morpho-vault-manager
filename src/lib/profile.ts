import { readdir } from "node:fs/promises";
import path from "node:path";
import { readJsonFile, removeFile, writeJsonFile } from "./fs.js";
import type { VaultManagerProfile, VaultManagerSettings } from "./types.js";

export function resolveProfilePath(settings: VaultManagerSettings, profileId: string): string {
  if (profileId === "default") {
    return settings.defaultProfilePath;
  }

  return path.join(path.dirname(settings.defaultProfilePath), `${profileId}.json`);
}

export async function loadProfile(
  settings: VaultManagerSettings,
  profileId: string
): Promise<{ path: string; profile: VaultManagerProfile | null }> {
  const profilePath = resolveProfilePath(settings, profileId);
  const profile = await readJsonFile<VaultManagerProfile>(profilePath);
  return { path: profilePath, profile };
}

export async function saveProfile(
  settings: VaultManagerSettings,
  profile: VaultManagerProfile
): Promise<string> {
  const profilePath = resolveProfilePath(settings, profile.profileId);
  await writeJsonFile(profilePath, profile);
  return profilePath;
}

export async function listProfileIds(settings: VaultManagerSettings): Promise<string[]> {
  const profilesDir = path.dirname(settings.defaultProfilePath);
  try {
    const entries = await readdir(profilesDir);
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function deleteProfileFile(settings: VaultManagerSettings, profileId: string): Promise<boolean> {
  return removeFile(resolveProfilePath(settings, profileId));
}
