# Talon – Eagle Clipper

An [Eagle](https://eagle.cool) plugin that imports what you share to Talon on your iPhone. Images, videos, files and web links arrive in your library with their name, note, tags and folders.

Talon – Eagle Clipper is an independent project and isn't affiliated with or endorsed by Eagle.

## What you need

- Eagle 4 on a Mac
- The Talon app on your iPhone
- A folder that syncs between both, such as one in iCloud Drive

The plugin does nothing without the app, because the app is what fills the folder.

## Install

1. Download the `.eagleplugin` file from [Releases](https://github.com/railstride/talon-eagle-clipper/releases).
2. Open it. Eagle installs the plugin.
3. Open **Talon – Eagle Clipper** from the plugin panel.
4. Click **Choose Folder…** and select the folder you picked in Talon.

Choose a folder outside your Eagle library. The plugin refuses one inside it.

## How it works

1. Talon writes each clip into the folder: the file, then a small `.clip.json` manifest.
2. The plugin checks the folder every 15 seconds while Eagle is running, and imports what arrived.
3. A clip leaves the folder only after Eagle confirmed the import. A clip that fails three times moves to `failed/` with the reason, and the app shows it there.

The plugin also writes `catalog.json` into the folder, so the app can offer your folders and tags.

## Privacy

The plugin makes no network requests of its own. It reads and writes only the folder you chose, and adds items to your library through Eagle. See [PRIVACY.md](PRIVACY.md).

## Develop

```bash
npm test
```

| Path        | What it is                                                     |
| ----------- | -------------------------------------------------------------- |
| `plugin/`   | The plugin itself. This is the folder to import into Eagle     |
| `test/`     | Importer tests, using a fake Eagle                             |
| `contract/` | Sample files of the folder format, shared with the app's tests |

To release, import `plugin/` as a local project in Eagle, right-click it in the plugin panel, and choose **Pack Plugin**. Eagle writes the `.eagleplugin` file.

## License

[MIT](LICENSE)
