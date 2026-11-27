# DriveScene Studio
DriveScene Studio is a 3D workbench for designing intelligent-driving visualizations and cockpit interfaces. Choose a driving or parking scene, adjust the vehicle, camera and environment, and export a background for your UI layout. [Open the live workbench](https://www.drivescenestudio.com/).

## Run locally
The repository includes both editable source and prebuilt browser bundles. From the repository root, run the following command with Python 3.

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [the interaction workbench](http://127.0.0.1:8000/studio/ui-draft/pro-prototype.html) or [the basic workbench](http://127.0.0.1:8000/studio/ui-draft/index.html). To build a static directory with the interaction workbench at the homepage, run `node scripts/package-static.mjs ../drivescene-site` from a Git checkout using Node.js 22.16 or newer. Use an empty output directory.

## Source and design references
The interaction controls and their source live under [studio/ui-draft](studio/ui-draft/), and the scene renderer is under [studio/engine](studio/engine/). The [SR colour specification](docs/SR-COLOR.md) documents the palette used for driving and parking scenes. This is a standalone source snapshot of the project’s main branch as of November 27, 2026.

## Licenses and credits
Peixin’s original application code in this repository is licensed under the [MIT License](LICENSE). The [asset and export terms](ASSET-LICENSE.md) cover original visual materials and use of exported output. Bundled third-party code, fonts, audio and vehicle models retain their respective licenses. See the [project credits](CREDITS.md) and [individual vehicle credits](vehicle-library/CREDITS.md).
