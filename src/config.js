// The addon is per-user (tied to a PMDB API key), so all user-specific
// settings are packed into a base64url segment of the install URL:
//   https://your-host/<config>/manifest.json
//
// Shape of the decoded config object:
// {
//   pmdbKey: "pm-...",
//   tmdbKey: "abcd1234...",
//   catalogs: [
//     { id: "continue-watching", name: "Continue Watching" },
//     { id: "watchlist", name: "Watchlist" },
//     { id: "list:lst_xxx", name: "Best Sci-Fi Movies", listId: "lst_xxx" }
//   ]
// }
//
// The order of the `catalogs` array is user-controlled (drag/arrow reorder
// on the configure page) and is preserved straight through to the manifest,
// which is what determines display order in Stremio.

function encodeConfig(obj) {
  const json = JSON.stringify(obj);
  return Buffer.from(json, 'utf8').toString('base64url');
}

function decodeConfig(str) {
  try {
    const json = Buffer.from(str, 'base64url').toString('utf8');
    const obj = JSON.parse(json);
    if (!obj.pmdbKey || !obj.tmdbKey) return null;
    if (!Array.isArray(obj.catalogs)) obj.catalogs = [];
    return obj;
  } catch (e) {
    return null;
  }
}

module.exports = { encodeConfig, decodeConfig };
