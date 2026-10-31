const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  Importer,
  flattenFolders,
  isInsideLibrary,
  isoSeconds,
  manifestProblem,
} = require("../plugin/js/importer.js");

const CONTRACT = path.join(__dirname, "..", "contract");
const clipID = "clip-1";

function setup({ addFromPath } = {}) {
  const inbox = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-inbox-"));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clipper-tmp-"));
  const calls = { files: [], links: [] };
  const eagle = {
    folder: {
      getAll: async () => [
        { id: "F1", name: "Posters", children: [{ id: "F2", name: "Swiss" }] },
      ],
    },
    tag: {
      get: async () => [
        { name: "rare", count: 1 },
        { name: "common", count: 9 },
      ],
    },
    library: { name: "Test" },
    item: {
      addFromPath:
        addFromPath ||
        (async (file, options) => {
          calls.files.push({ body: fs.readFileSync(file, "utf8"), options });
          return "item";
        }),
      addBookmark: async (url, options) => {
        calls.links.push({ url, options });
        return "item";
      },
    },
  };
  let imported = new Set();
  const ledger = {
    load: () => new Set(imported),
    save: (ids) => {
      imported = new Set(ids);
    },
  };
  return {
    importer: new Importer({ inboxPath: inbox, eagle, fs, tmpDir, ledger }),
    inbox,
    calls,
    tmpDir,
  };
}

function writeClip(inbox, manifest, payload) {
  const full = {
    version: 1,
    id: clipID,
    kind: "file",
    payload: `${clipID}.jpg`,
    tags: [],
    folderIDs: [],
    createdAt: "2026-10-31T10:00:00Z",
    ...manifest,
  };
  if (payload !== undefined)
    fs.writeFileSync(path.join(inbox, full.payload), payload);
  fs.writeFileSync(
    path.join(inbox, `${full.id}.clip.json`),
    JSON.stringify(full),
  );
}

const inboxFiles = (inbox) =>
  fs.readdirSync(inbox).filter((name) => name !== "catalog.json");

test("imports a file with its details, then clears it from the inbox", async () => {
  const { importer, inbox, calls, tmpDir } = setup();
  writeClip(
    inbox,
    {
      name: "Poster",
      tags: ["grid"],
      folderIDs: ["F2", "gone"],
      url: "https://example.com",
      note: "n",
    },
    "image",
  );

  assert.deepEqual(await importer.tick(), {
    imported: 1,
    waiting: 0,
    failed: 0,
  });

  assert.equal(calls.files[0].body, "image");
  assert.deepEqual(calls.files[0].options, {
    name: "Poster",
    tags: ["grid"],
    folders: ["F2"],
    annotation: "n",
    website: "https://example.com",
  });
  assert.deepEqual(inboxFiles(inbox), []);
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test("imports a link with its preview as thumbnail", async () => {
  const { importer, inbox, calls } = setup();
  writeClip(
    inbox,
    { kind: "link", url: "https://example.com/a", name: "A" },
    "jpg",
  );

  await importer.tick();

  assert.equal(calls.links[0].url, "https://example.com/a");
  assert.equal(
    calls.links[0].options.base64,
    `data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}`,
  );
  assert.deepEqual(inboxFiles(inbox), []);
});

test("imports a link whose optional preview never arrives", async () => {
  const { importer, inbox, calls } = setup();
  writeClip(inbox, {
    kind: "link",
    url: "https://example.com/a",
    payload: null,
  });

  assert.equal((await importer.tick()).imported, 1);
  assert.equal(calls.links[0].options.base64, undefined);
});

test("waits when the manifest arrives before its payload", async () => {
  const { importer, inbox, calls } = setup();
  writeClip(inbox, {});

  assert.deepEqual(await importer.tick(), {
    imported: 0,
    waiting: 1,
    failed: 0,
  });
  assert.equal(calls.files.length, 0);

  fs.writeFileSync(path.join(inbox, `${clipID}.jpg`), "late");
  assert.equal((await importer.tick()).imported, 1);
});

test("keeps the file through failures and moves it to failed with the reason", async () => {
  const { importer, inbox } = setup({
    addFromPath: async () => {
      throw new Error("Eagle refused");
    },
  });
  writeClip(inbox, {}, "image");

  assert.equal((await importer.tick()).waiting, 1);
  assert.equal((await importer.tick()).waiting, 1);
  assert.ok(fs.existsSync(path.join(inbox, `${clipID}.jpg`)));

  assert.equal((await importer.tick()).failed, 1);
  const failed = path.join(inbox, "failed");
  assert.equal(
    fs.readFileSync(path.join(failed, `${clipID}.jpg`), "utf8"),
    "image",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(failed, `${clipID}.clip.json`))).error,
    "Eagle refused",
  );
  assert.deepEqual(inboxFiles(inbox), ["failed"]);
});

test("refuses a payload that points outside the inbox", async () => {
  const { importer, inbox, calls } = setup();
  const secret = path.join(path.dirname(inbox), "clipper-secret.txt");
  fs.writeFileSync(secret, "secret");
  writeClip(inbox, { payload: "../clipper-secret.txt" });

  assert.equal((await importer.tick()).failed, 1);
  assert.equal(calls.files.length, 0);
  assert.ok(fs.existsSync(secret));
  fs.rmSync(secret);
});

test("never imports the same clip twice when a removal did not happen", async () => {
  const { importer, inbox, calls } = setup();
  writeClip(inbox, {}, "image");
  await importer.tick();

  writeClip(inbox, {}, "image");
  assert.equal((await importer.tick()).imported, 1);

  assert.equal(calls.files.length, 1);
  assert.deepEqual(inboxFiles(inbox), []);
});

test("quarantines a manifest that is not valid JSON after retries", async () => {
  const { importer, inbox } = setup();
  fs.writeFileSync(path.join(inbox, "broken.clip.json"), "{");

  await importer.tick();
  await importer.tick();
  assert.equal((await importer.tick()).failed, 1);
  assert.ok(fs.existsSync(path.join(inbox, "failed", "broken.clip.json")));
});

test("writes the catalog sorted by use and leaves it alone when unchanged", async () => {
  const { importer, inbox } = setup();
  await importer.tick();

  const file = path.join(inbox, "catalog.json");
  const catalog = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(catalog.tags, ["common", "rare"]);
  assert.equal(catalog.folders[1].path, "Posters / Swiss");

  fs.writeFileSync(file, "untouched");
  await importer.tick();
  assert.equal(fs.readFileSync(file, "utf8"), "untouched");
});

test("stays on the format the iOS app writes and reads", () => {
  const clip = JSON.parse(fs.readFileSync(path.join(CONTRACT, "clip.v1.json")));
  assert.equal(manifestProblem(clip, `${clip.id}.clip.json`), null);

  const catalog = JSON.parse(
    fs.readFileSync(path.join(CONTRACT, "catalog.v1.json")),
  );
  assert.deepEqual(
    Object.keys(catalog.folders[0]),
    Object.keys(flattenFolders([{ id: "a", name: "b" }])[0]),
  );
  assert.match(
    isoSeconds(new Date()),
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
  );
});

test("recognizes folders inside an Eagle library", () => {
  assert.equal(isInsideLibrary("/Users/me/Cosmos.library"), true);
  assert.equal(isInsideLibrary("/Users/me/Cosmos.library/images"), true);
  assert.equal(
    isInsideLibrary("/Users/me/Library/Mobile Documents/Inbox"),
    false,
  );
});
