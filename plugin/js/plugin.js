/* global document, eagle, localStorage, window */
const fs = require("fs");
const os = require("os");
const path = require("path");

const POLL_INTERVAL_MS = 15000;
const INBOX_KEY = "clipper.inboxPath";
const LEDGER_KEY = "clipper.importedIDs";
const THEMES = ["light", "lightgray", "gray", "blue", "purple", "dark"];

function applyTheme(name) {
  const theme = String(name).toLowerCase();
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  document.body.setAttribute(
    "theme",
    THEMES.includes(theme) ? theme : prefersDark ? "dark" : "light",
  );
}

const readStored = (key) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStored = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    console.error("Clipper could not save a setting", error);
  }
};

const ledger = {
  load() {
    try {
      return new Set(JSON.parse(readStored(LEDGER_KEY)) || []);
    } catch {
      return new Set();
    }
  },
  save(ids) {
    writeStored(LEDGER_KEY, JSON.stringify([...ids].slice(-500)));
  },
};

eagle.onPluginCreate((plugin) => {
  const { Importer, isInsideLibrary } = require(
    path.join(plugin.path, "js", "importer.js"),
  );
  const ui = {
    inbox: document.getElementById("inbox"),
    imported: document.getElementById("imported"),
    status: document.getElementById("status"),
  };

  let importer = null;
  let running = false;
  let importedTotal = 0;

  const say = (message, refused = false) => {
    ui.status.textContent = message;
    ui.status.classList.toggle("refused", refused);
  };

  const start = (inboxPath) => {
    ui.inbox.textContent = inboxPath;
    importer = new Importer({
      inboxPath,
      eagle,
      fs,
      tmpDir: os.tmpdir(),
      ledger,
    });
    tick();
  };

  async function tick() {
    if (!importer || running) return;
    running = true;
    try {
      const summary = await importer.tick();
      importedTotal += summary.imported;
      ui.imported.textContent = String(importedTotal);
      say(
        summary.waiting > 0
          ? `${summary.waiting} waiting to sync`
          : "Up to date",
      );
    } catch (error) {
      say(error.message, true);
      console.error(error);
    } finally {
      running = false;
    }
  }

  document.getElementById("choose").addEventListener("click", async () => {
    const result = await eagle.dialog.showOpenDialog({
      title: "Choose the inbox folder you picked in Clipper on your iPhone",
      properties: ["openDirectory", "createDirectory"],
    });
    const chosen = result && !result.canceled ? result.filePaths[0] : null;
    if (!chosen) return;
    if (isInsideLibrary(chosen)) {
      say("Choose a folder outside your Eagle library.", true);
      return;
    }
    writeStored(INBOX_KEY, chosen);
    start(chosen);
  });

  applyTheme(eagle.app.theme);
  eagle.onThemeChanged(applyTheme);

  const saved = readStored(INBOX_KEY);
  if (saved) start(saved);
  setInterval(tick, POLL_INTERVAL_MS);
});

eagle.onLibraryChanged(() => {
  console.log(
    "Clipper: library changed, the catalog is refreshed on the next check",
  );
});
