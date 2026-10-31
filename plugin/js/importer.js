const path = require("path");

const MANIFEST_SUFFIX = ".clip.json";
const CATALOG_NAME = "catalog.json";
const FAILED_FOLDER = "failed";
const SUPPORTED_VERSION = 1;
const MAX_ATTEMPTS = 3;
const MAX_CATALOG_TAGS = 200;

/** Returns why a manifest cannot be imported, or null. The inbox is synced data, so nothing in it is trusted. */
function manifestProblem(manifest, fileName) {
  if (!manifest || typeof manifest !== "object")
    return "Manifest is not an object";
  if (manifest.version !== SUPPORTED_VERSION)
    return `Unsupported version ${manifest.version}`;
  if (`${manifest.id}${MANIFEST_SUFFIX}` !== fileName)
    return "Manifest id does not match its file";
  if (manifest.kind !== "file" && manifest.kind !== "link")
    return `Unknown kind ${manifest.kind}`;
  const payload = manifest.payload;
  if (payload === null || payload === undefined) {
    if (manifest.kind === "file") return "File clip has no payload";
  } else if (
    typeof payload !== "string" ||
    payload !== path.basename(payload) ||
    payload.startsWith(".")
  ) {
    return "Payload must be a plain file name";
  }
  if (manifest.kind === "link" && !isWebURL(manifest.url))
    return "Link clip has no web URL";
  return null;
}

function isWebURL(value) {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Eagle owns everything inside a library, so an inbox must never live there. */
function isInsideLibrary(folder) {
  return folder.split(path.sep).some((part) => /\.library$/i.test(part));
}

function strings(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item)
    : [];
}

/** Whole seconds, because Swift's `.iso8601` decoder rejects fractional seconds. */
function isoSeconds(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function flattenFolders(folders, parents = []) {
  return folders.flatMap((folder) => {
    const trail = [...parents, folder.name];
    const entry = { id: folder.id, name: folder.name, path: trail.join(" / ") };
    return [entry, ...flattenFolders(folder.children || [], trail)];
  });
}

class Importer {
  constructor({ inboxPath, eagle, fs, tmpDir, ledger }) {
    this.inboxPath = inboxPath;
    this.eagle = eagle;
    this.fs = fs;
    this.tmpDir = tmpDir;
    this.ledger = ledger;
    this.attempts = new Map();
    this.catalogBody = null;
  }

  /** One pass: refresh the catalog, then import what has arrived. */
  async tick() {
    const folders = flattenFolders(await this.eagle.folder.getAll());
    await this.writeCatalog(folders);

    const knownFolderIDs = new Set(folders.map((folder) => folder.id));
    const summary = { imported: 0, waiting: 0, failed: 0 };
    for (const fileName of this.manifestNames()) {
      summary[await this.process(fileName, knownFolderIDs)] += 1;
    }
    return summary;
  }

  manifestNames() {
    return this.fs
      .readdirSync(this.inboxPath)
      .filter((name) => name.endsWith(MANIFEST_SUFFIX) && !name.startsWith("."))
      .sort();
  }

  async process(fileName, knownFolderIDs) {
    const manifestPath = path.join(this.inboxPath, fileName);
    let manifest = null;
    try {
      manifest = JSON.parse(
        await this.fs.promises.readFile(manifestPath, "utf8"),
      );
    } catch (error) {
      return this.recordFailure(fileName, null, error);
    }

    const imported = this.ledger.load();
    if (imported.has(manifest.id)) {
      this.removeClip(manifest, manifestPath);
      return "imported";
    }

    const problem = manifestProblem(manifest, fileName);
    if (problem) return this.moveToFailed(fileName, manifest, problem);

    // iCloud does not keep files in order, so the manifest can arrive before its payload.
    const payloadPath = manifest.payload
      ? path.join(this.inboxPath, manifest.payload)
      : null;
    if (manifest.kind === "file" && !this.fs.existsSync(payloadPath))
      return "waiting";

    const options = {
      name: typeof manifest.name === "string" ? manifest.name : undefined,
      tags: strings(manifest.tags),
      folders: strings(manifest.folderIDs).filter((id) =>
        knownFolderIDs.has(id),
      ),
      annotation: typeof manifest.note === "string" ? manifest.note : undefined,
    };

    const workPath = path.join(
      this.tmpDir,
      `clipper-${path.basename(payloadPath || manifest.id)}`,
    );
    try {
      if (manifest.kind === "file") {
        // Reading through a local copy makes macOS download the file before Eagle sees it.
        await this.fs.promises.copyFile(payloadPath, workPath);
        await this.eagle.item.addFromPath(workPath, {
          ...options,
          website: isWebURL(manifest.url) ? manifest.url : undefined,
        });
      } else {
        await this.eagle.item.addBookmark(manifest.url, {
          ...options,
          base64: await this.previewBase64(payloadPath),
        });
      }
    } catch (error) {
      return this.recordFailure(fileName, manifest, error);
    } finally {
      this.fs.rmSync(workPath, { force: true });
    }

    // Record first: a crash after this point must not import the clip a second time.
    imported.add(manifest.id);
    this.ledger.save(imported);
    this.attempts.delete(fileName);
    this.removeClip(manifest, manifestPath);
    return "imported";
  }

  async previewBase64(previewPath) {
    if (!previewPath || !this.fs.existsSync(previewPath)) return undefined;
    const data = await this.fs.promises.readFile(previewPath);
    return `data:image/jpeg;base64,${data.toString("base64")}`;
  }

  removeClip(manifest, manifestPath) {
    if (
      manifest.payload &&
      manifest.payload === path.basename(manifest.payload)
    ) {
      this.fs.rmSync(path.join(this.inboxPath, manifest.payload), {
        force: true,
      });
    }
    this.fs.rmSync(manifestPath, { force: true });
  }

  recordFailure(fileName, manifest, error) {
    const attempts = (this.attempts.get(fileName) || 0) + 1;
    this.attempts.set(fileName, attempts);
    if (attempts < MAX_ATTEMPTS) return "waiting";
    return this.moveToFailed(fileName, manifest, error.message);
  }

  /** Keeps the payload: a clip is only ever deleted after Eagle confirmed the import. */
  moveToFailed(fileName, manifest, reason) {
    const failedPath = path.join(this.inboxPath, FAILED_FOLDER);
    this.fs.mkdirSync(failedPath, { recursive: true });

    const payload = manifest && manifest.payload;
    if (typeof payload === "string" && payload === path.basename(payload)) {
      const payloadPath = path.join(this.inboxPath, payload);
      if (this.fs.existsSync(payloadPath)) {
        this.fs.renameSync(payloadPath, path.join(failedPath, payload));
      }
    }

    const manifestPath = path.join(this.inboxPath, fileName);
    const target = path.join(failedPath, fileName);
    if (manifest) {
      this.fs.writeFileSync(
        target,
        JSON.stringify({ ...manifest, error: reason }, null, 2),
      );
      this.fs.rmSync(manifestPath, { force: true });
    } else {
      this.fs.renameSync(manifestPath, target);
    }
    this.attempts.delete(fileName);
    return "failed";
  }

  /** Rewrites the catalog only when it changed, so an idle Mac causes no iCloud traffic. */
  async writeCatalog(folders) {
    const tags = await this.eagle.tag.get();
    const names = tags
      .slice()
      .sort((a, b) => (b.count || 0) - (a.count || 0))
      .slice(0, MAX_CATALOG_TAGS)
      .map((tag) => tag.name);
    const content = {
      folders,
      libraryName: this.eagle.library.name || "",
      tags: names,
      version: 1,
    };

    const body = JSON.stringify(content);
    if (body === this.catalogBody) return;
    this.catalogBody = body;

    const target = path.join(this.inboxPath, CATALOG_NAME);
    const temporary = `${target}.tmp`;
    const file = { ...content, updatedAt: isoSeconds(new Date()) };
    this.fs.writeFileSync(temporary, JSON.stringify(file, null, 2));
    this.fs.renameSync(temporary, target);
  }
}

module.exports = {
  Importer,
  flattenFolders,
  isInsideLibrary,
  isoSeconds,
  manifestProblem,
};
