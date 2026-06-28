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
2. Push this workspace with the generated root static files, `tools/`, `.gitignore`, and this README.
3. In GitHub, open Settings -> Pages.
4. Under Build and deployment, set Source to `Deploy from a branch`.
5. Select branch `main` and folder `/ (root)`, then save.

The site is static and does not need a GitHub Actions workflow. Domain setup is intentionally left out so it can be configured separately.