# Nelatko static export

This workspace contains a static GitHub Pages export of the old Drupal site at http://nelatko.cz/.

The publishable site is in the repository root: `index.html`, `files/`, `node/`, `image/`, `modules/`, `themes/`, and the other generated static paths. The original FTP backup, logs, database backups, and local `static-site/` staging folder are intentionally ignored by `.gitignore` and should not be pushed to GitHub.

## Regenerate

```sh
node tools/export-static-site.mjs
rsync -a static-site/ ./ --exclude README.md
```

The exporter crawls the live site into `static-site/`, removes Contact and Guest Book links/routes, keeps old comments as read-only HTML, and copies public image/theme assets from the FTP backup. The `rsync` command copies the generated artifact into the repository root for publishing.

## Preview

```sh
python3 -m http.server 8080 --directory .
```

Then open http://localhost:8080/.

## Publish on GitHub Pages

1. Create a new GitHub repository.
2. Push this workspace with the generated root static files, `tools/`, `.github/`, `.gitignore`, and this README.
3. In the repository settings, set Pages source to GitHub Actions.
4. Push to the `main` branch or run the `Deploy static site to GitHub Pages` workflow manually.

The workflow uploads the repository root as the Pages artifact. Domain setup is intentionally left out so it can be configured separately.