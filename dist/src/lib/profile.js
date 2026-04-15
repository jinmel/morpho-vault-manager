import path from "node:path";
import { readJsonFile, writeJsonFile } from "./fs.js";
export function resolveProfilePath(settings, profileId) {
    if (profileId === "default") {
        return settings.defaultProfilePath;
    }
    return path.join(path.dirname(settings.defaultProfilePath), `${profileId}.json`);
}
export async function loadProfile(settings, profileId) {
    const profilePath = resolveProfilePath(settings, profileId);
    const profile = await readJsonFile(profilePath);
    return { path: profilePath, profile };
}
export async function saveProfile(settings, profile) {
    const profilePath = resolveProfilePath(settings, profile.profileId);
    await writeJsonFile(profilePath, profile);
    return profilePath;
}
