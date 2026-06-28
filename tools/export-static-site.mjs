#!/usr/bin/env node

import { cp, mkdir, rm, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_ORIGIN = process.env.NELATKO_SOURCE_ORIGIN || 'http://nelatko.cz';
const SOURCE_HOST = new URL(SOURCE_ORIGIN).host;
const OUTPUT_DIR = path.join(ROOT, 'static-site');
const REPORT_DIR = path.join(ROOT, 'export-report');
const BACKUP_FILES_DIR = path.join(ROOT, 'public_html', 'www', 'files');
const BACKUP_THEME_DIRS = [
  path.join(ROOT, 'public_html', 'www', 'themes', 'chameleon'),
  path.join(ROOT, 'public_html', 'www', 'sites', 'nelatko.cz', 'themes', 'nelatko'),
];

const MAX_PAGES = Number.parseInt(process.env.NELATKO_MAX_PAGES || '2000', 10);
const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.NELATKO_REQUEST_TIMEOUT_MS || '15000', 10);
const USER_AGENT = 'nelatko-static-export/1.0 (+https://nelatko.cz/)';

const htmlQueue = [];
const assetQueue = [];
const seenHtml = new Set();
const seenAssets = new Set();
const exportedPages = [];
const exportedAssets = [];
const skippedUrls = [];
const failedUrls = [];
const discoveredUrls = new Set();

await main();

async function main() {
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await rm(REPORT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await mkdir(REPORT_DIR, { recursive: true });
  await writeFile(path.join(OUTPUT_DIR, '.nojekyll'), '');

  enqueueHtml(new URL('/', SOURCE_ORIGIN));

  while (htmlQueue.length > 0 && exportedPages.length < MAX_PAGES) {
    const url = htmlQueue.shift();
    await exportHtml(url);
    if (exportedPages.length > 0 && exportedPages.length % 25 === 0) {
      console.log(`Exported ${exportedPages.length} pages...`);
    }
  }

  while (assetQueue.length > 0) {
    const url = assetQueue.shift();
    await exportAsset(url);
  }

  await copyBackupPublicAssets();
  await writeReadme();
  await writeReport();

  console.log(`Exported ${exportedPages.length} pages and ${exportedAssets.length} live assets to ${path.relative(ROOT, OUTPUT_DIR)}`);
  if (failedUrls.length > 0) {
    console.log(`Some URLs failed; see ${path.relative(ROOT, path.join(REPORT_DIR, 'failed-urls.txt'))}`);
  }
}

function enqueueHtml(url) {
  const normalized = normalizeHtmlUrl(url);
  if (!normalized) return;
  const key = normalized.href;
  if (seenHtml.has(key)) return;
  seenHtml.add(key);
  htmlQueue.push(normalized);
}

function enqueueAsset(url) {
  const normalized = normalizeAssetUrl(url);
  if (!normalized) return;
  const key = normalized.href;
  if (seenAssets.has(key)) return;
  seenAssets.add(key);
  assetQueue.push(normalized);
}

async function exportHtml(url) {
  discoveredUrls.add(url.href);
  if (isForbiddenUrl(url)) {
    skippedUrls.push(url.href);
    return;
  }

  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    failedUrls.push(`${url.href}\t${error.message}`);
    return;
  }

  if (!response.ok) {
    failedUrls.push(`${url.href}\tHTTP ${response.status}`);
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  const body = Buffer.from(await response.arrayBuffer());

  if (!contentType.includes('text/html')) {
    failedUrls.push(`${url.href}\tExpected HTML, got ${contentType || 'unknown content type'}`);
    return;
  }

  const sourceHtml = body.toString('utf8');
  collectPageDependencies(sourceHtml, url);
  const cleanedHtml = cleanHtml(sourceHtml, url);
  const outputPath = htmlOutputPath(url);
  await writeFileEnsured(outputPath, cleanedHtml);
  exportedPages.push(`${url.href}\t${path.relative(OUTPUT_DIR, outputPath)}`);
}

async function exportAsset(url) {
  discoveredUrls.add(url.href);
  if (isForbiddenUrl(url)) {
    skippedUrls.push(url.href);
    return;
  }

  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch (error) {
    failedUrls.push(`${url.href}\t${error.message}`);
    return;
  }

  if (!response.ok) {
    failedUrls.push(`${url.href}\tHTTP ${response.status}`);
    return;
  }

  const contentType = response.headers.get('content-type') || '';
  const body = Buffer.from(await response.arrayBuffer());
  const outputPath = assetOutputPath(url, contentType);
  await writeFileEnsured(outputPath, body);
  exportedAssets.push(`${url.href}\t${path.relative(OUTPUT_DIR, outputPath)}`);

  if (contentType.includes('text/css') || outputPath.endsWith('.css')) {
    collectCssDependencies(body.toString('utf8'), url);
  }
}

function collectPageDependencies(html, baseUrl) {
  for (const rawUrl of extractAttributeUrls(html)) {
    const resolved = resolveUrl(rawUrl, baseUrl);
    if (!resolved) continue;

    discoveredUrls.add(resolved.href);

    if (resolved.host === SOURCE_HOST && isLikelyHtmlLink(rawUrl, resolved)) {
      enqueueHtml(resolved);
    } else if (resolved.host === SOURCE_HOST && !isForbiddenUrl(resolved) && isLikelyAssetUrl(resolved)) {
      enqueueAsset(resolved);
    }
  }

  for (const rawUrl of extractCssImportUrls(html)) {
    const resolved = resolveUrl(rawUrl, baseUrl);
    if (resolved && resolved.host === SOURCE_HOST && !isForbiddenUrl(resolved)) {
      enqueueAsset(resolved);
    }
  }
}

function collectCssDependencies(css, baseUrl) {
  for (const rawUrl of extractCssUrls(css)) {
    const resolved = resolveUrl(rawUrl, baseUrl);
    if (resolved && resolved.host === SOURCE_HOST && !isForbiddenUrl(resolved)) {
      enqueueAsset(resolved);
    }
  }
}

function extractAttributeUrls(html) {
  const urls = [];
  const attributePattern = /\s(?:href|src|action)\s*=\s*(["'])(.*?)\1/gi;
  for (const match of html.matchAll(attributePattern)) {
    urls.push(decodeHtmlEntities(match[2]).trim());
  }
  return urls;
}

function extractCssImportUrls(html) {
  const urls = [];
  const importPattern = /@import\s+(["'])(.*?)\1/gi;
  for (const match of html.matchAll(importPattern)) {
    urls.push(decodeHtmlEntities(match[2]).trim());
  }
  return urls;
}

function extractCssUrls(css) {
  const urls = [];
  const urlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  const importPattern = /@import\s+(?:url\()?\s*(["'])(.*?)\1\s*\)?/gi;
  for (const match of css.matchAll(urlPattern)) urls.push(match[2].trim());
  for (const match of css.matchAll(importPattern)) urls.push(match[2].trim());
  return urls;
}

function cleanHtml(html, baseUrl) {
  let output = html;

  output = output.replace(/<link\b[^>]*rel=["']alternate["'][^>]*>/gi, '');
  output = output.replace(/<form\b[\s\S]*?<\/form>/gi, '');
  output = output.replace(/<li\b[^>]*>\s*<a\b[^>]*href=["'][^"']*["'][^>]*>\s*(?:Kontakt|Návštěvní kniha)\s*<\/a>\s*<\/li>\s*/gi, '');
  output = output.replace(/<li\b[^>]*>\s*<a\b[^>]*href=["'][^"']*(?:blueboard\.cz\/kniha|\/contact\/?|\/guestbook\/?|\/node\/8(?:["'?#/]|$))[^"']*["'][^>]*>[\s\S]*?<\/a>\s*<\/li>\s*/gi, '');
  output = output.replace(/<a\b([^>]*?)href=(["'])(.*?)\2([^>]*)>([\s\S]*?)<\/a>/gi, (match, before, quote, href, after, label) => {
    const resolved = resolveUrl(decodeHtmlEntities(href).trim(), baseUrl);
    const text = stripTags(label);
    if (isForbiddenHref(href, resolved) || /^\s*(Kontakt|Návštěvní kniha)\s*$/i.test(text)) {
      return label;
    }

    if (!resolved || resolved.protocol.startsWith('mailto') || resolved.protocol.startsWith('tel')) {
      return match;
    }

    if (resolved.host !== SOURCE_HOST) {
      return `<a${before}href=${quote}${escapeHtmlAttribute(resolved.href)}${quote}${after}>${label}</a>`;
    }

    const rewritten = isLikelyHtmlLink(href, resolved)
      ? publicHtmlHref(resolved)
      : publicAssetHref(resolved);
    return `<a${before}href=${quote}${escapeHtmlAttribute(rewritten)}${quote}${after}>${label}</a>`;
  });

  output = output.replace(/\s(?:src|action)=(["'])(.*?)\1/gi, (match, quote, href) => {
    const resolved = resolveUrl(decodeHtmlEntities(href).trim(), baseUrl);
    if (!resolved || resolved.host !== SOURCE_HOST) return match;
    if (isForbiddenUrl(resolved)) return '';
    return `${match.startsWith(' action') ? ' action' : ' src'}=${quote}${escapeHtmlAttribute(publicAssetHref(resolved))}${quote}`;
  });

  output = output.replace(/@import\s+(["'])(.*?)\1/gi, (match, quote, href) => {
    const resolved = resolveUrl(decodeHtmlEntities(href).trim(), baseUrl);
    if (!resolved || resolved.host !== SOURCE_HOST || isForbiddenUrl(resolved)) return '';
    return `@import ${quote}${escapeHtmlAttribute(publicAssetHref(resolved))}${quote}`;
  });

  output = output.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (match, quote, href) => {
    const resolved = resolveUrl(decodeHtmlEntities(href).trim(), baseUrl);
    if (!resolved || resolved.host !== SOURCE_HOST || isForbiddenUrl(resolved)) return match;
    return `url(${quote}${escapeHtmlAttribute(publicAssetHref(resolved))}${quote})`;
  });

  return output;
}

function resolveUrl(rawUrl, baseUrl) {
  if (!rawUrl || rawUrl.startsWith('#')) return null;
  if (/^(?:javascript|data):/i.test(rawUrl)) return null;
  try {
    return new URL(rawUrl, baseUrl);
  } catch {
    return null;
  }
}

function normalizeHtmlUrl(url) {
  if (url.host !== SOURCE_HOST) return null;
  if (isForbiddenUrl(url)) {
    skippedUrls.push(url.href);
    return null;
  }

  const normalized = new URL(url.href);
  normalized.hash = '';
  normalized.protocol = 'http:';

  for (const key of [...normalized.searchParams.keys()]) {
    if (key !== 'page' && key !== 'q') normalized.searchParams.delete(key);
  }

  if (normalized.searchParams.has('q')) {
    const queryPath = normalized.searchParams.get('q') || '';
    if (!queryPath || queryPath.includes(':') || queryPath.startsWith('/')) return null;
    normalized.pathname = `/${queryPath.replace(/^\/+/, '')}`;
    normalized.searchParams.delete('q');
  }

  if (normalized.searchParams.has('page') && !/^\d+$/.test(normalized.searchParams.get('page'))) {
    normalized.search = '';
  }

  return normalized;
}

function normalizeAssetUrl(url) {
  if (url.host !== SOURCE_HOST) return null;
  if (isForbiddenUrl(url)) {
    skippedUrls.push(url.href);
    return null;
  }
  const normalized = new URL(url.href);
  normalized.hash = '';
  normalized.protocol = 'http:';
  if (normalized.searchParams.has('q')) return null;
  return normalized;
}

function isLikelyHtmlLink(rawUrl, url) {
  const pathname = url.pathname;
  if (url.search && !/^(?:\?page=\d+|\?q=[^&]+|\?q=[^&]+&page=\d+)$/.test(url.search)) return false;
  if (/\/$/.test(pathname)) return true;
  if (/\.(?:html?|xhtml)$/i.test(pathname)) return true;
  if (/\.(?:css|js|png|jpe?g|gif|webp|svg|ico|xml|rss|pdf|zip|gz|mp4|mov|avi|wmv|mp3|ogg|txt)$/i.test(pathname)) return false;
  if (/^(?:#|mailto:|tel:|javascript:|data:)/i.test(rawUrl)) return false;
  return true;
}

function isLikelyAssetUrl(url) {
  return /\.(?:css|js|png|jpe?g|gif|webp|svg|ico|xml|rss|pdf|zip|gz|mp4|mov|avi|wmv|mp3|ogg|txt)$/i.test(url.pathname);
}

function isForbiddenHref(rawHref, resolved) {
  if (/blueboard\.cz\/kniha/i.test(rawHref)) return true;
  if (/\b(?:contact|guestbook)\b/i.test(rawHref)) return true;
  if (/\/node\/8(?:[/?#]|$)/i.test(rawHref)) return true;
  return Boolean(resolved && isForbiddenUrl(resolved));
}

function isForbiddenUrl(url) {
  const pathname = slashPath(decodeURIComponent(url.pathname));
  if (url.host !== SOURCE_HOST && /blueboard\.cz$/i.test(url.host) && /kniha/i.test(pathname)) return true;
  if (pathname === '/node/8' || pathname.startsWith('/node/8/')) return true;
  if (pathname === '/contact' || pathname.startsWith('/contact/')) return true;
  if (pathname === '/guestbook' || pathname.startsWith('/guestbook/')) return true;
  if (/^\/user\/[^/]+\/(?:contact|guestbook)(?:\/|$)/.test(pathname)) return true;
  if (pathname === '/user/login' || pathname === '/user/register') return true;
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return true;
  if (pathname === '/node/add' || pathname.startsWith('/node/add/')) return true;
  if (/\/(?:cron|install|update|xmlrpc)\.php$/i.test(pathname)) return true;
  return false;
}

function htmlOutputPath(url) {
  const publicPath = publicHtmlHref(url);
  return path.join(OUTPUT_DIR, publicPath.replace(/^\//, ''), publicPath.endsWith('/') ? 'index.html' : '');
}

function assetOutputPath(url, contentType = '') {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) {
    const extension = extensionForContentType(contentType) || '.asset';
    pathname += `asset-${hashUrl(url.href)}${extension}`;
  }
  if (url.search) {
    const extension = path.extname(pathname);
    const withoutExtension = extension ? pathname.slice(0, -extension.length) : pathname;
    pathname = `${withoutExtension}-${hashUrl(url.search)}${extension}`;
  }
  return path.join(OUTPUT_DIR, pathname.replace(/^\//, ''));
}

function publicHtmlHref(url) {
  const normalized = normalizeHtmlUrl(url) || url;
  let pathname = slashPath(decodeURIComponent(normalized.pathname));
  if (normalized.searchParams?.has('q')) {
    pathname = slashPath(normalized.searchParams.get('q'));
  }
  pathname = pathname.replace(/\/index\.html?$/i, '/');
  pathname = pathname.replace(/\.html?$/i, '/');
  if (normalized.searchParams?.has('page')) {
    const page = normalized.searchParams.get('page');
    pathname = `${pathname.replace(/\/$/, '')}/page-${page}/`;
  }
  return pathname.endsWith('/') ? pathname : `${pathname}/`;
}

function publicAssetHref(url) {
  let pathname = slashPath(decodeURIComponent(url.pathname));
  pathname = repairKnownAssetPath(pathname);
  if (url.search) {
    const extension = path.extname(pathname);
    const withoutExtension = extension ? pathname.slice(0, -extension.length) : pathname;
    pathname = `${withoutExtension}-${hashUrl(url.search)}${extension}`;
  }
  return pathname;
}

function repairKnownAssetPath(pathname) {
  const repairs = new Map([
    ['/files/nela0706_27.jpg', '/files/images/0706/nela0706_27.jpg'],
    ['/files/images/fotky Dita/Dita1.jpg', '/files/images/Dita_fotky/Dita1.JPG'],
  ]);
  return repairs.get(pathname) || pathname;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function copyBackupPublicAssets() {
  await copyDirectoryIfPresent(BACKUP_FILES_DIR, path.join(OUTPUT_DIR, 'files'));
  for (const themeDir of BACKUP_THEME_DIRS) {
    const relativeThemePath = path.relative(path.join(ROOT, 'public_html', 'www'), themeDir);
    await copyDirectoryIfPresent(themeDir, path.join(OUTPUT_DIR, relativeThemePath));
  }
}

async function copyDirectoryIfPresent(from, to) {
  try {
    const details = await stat(from);
    if (!details.isDirectory()) return;
  } catch {
    return;
  }

  await cp(from, to, {
    recursive: true,
    force: true,
    filter: (source) => {
      const basename = path.basename(source);
      if (basename === '.htaccess') return false;
      return !/\.(?:php|inc|module|install|engine|theme)$/i.test(basename);
    },
  });
}

async function writeReadme() {
  const readme = `# Nelatko static site\n\nThis folder is the generated static export of http://nelatko.cz/ for GitHub Pages.\n\n- Generated pages use pretty folder URLs such as \`/odkazy/\`.\n- Old Drupal comments are preserved as read-only HTML.\n- Contact and guest book links/routes are intentionally removed.\n- Dynamic Drupal forms, login/register, admin, and PHP files are not part of this artifact.\n\nRegenerate from the workspace root with:\n\n\`\`\`sh\nnode tools/export-static-site.mjs\n\`\`\`\n\nFor local preview, serve this directory as a static site, for example:\n\n\`\`\`sh\npython3 -m http.server 8080 --directory static-site\n\`\`\`\n`;
  await writeFile(path.join(OUTPUT_DIR, 'README.md'), readme);
}

async function writeReport() {
  await writeFile(path.join(REPORT_DIR, 'pages.txt'), `${exportedPages.join('\n')}\n`);
  await writeFile(path.join(REPORT_DIR, 'assets.txt'), `${exportedAssets.join('\n')}\n`);
  await writeFile(path.join(REPORT_DIR, 'discovered-urls.txt'), `${[...discoveredUrls].sort().join('\n')}\n`);
  await writeFile(path.join(REPORT_DIR, 'skipped-urls.txt'), `${[...new Set(skippedUrls)].sort().join('\n')}\n`);
  await writeFile(path.join(REPORT_DIR, 'failed-urls.txt'), `${failedUrls.join('\n')}\n`);
}

async function writeFileEnsured(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

function slashPath(value) {
  return `/${value.replace(/^\/+/, '')}`;
}

function hashUrl(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 8);
}

function extensionForContentType(contentType) {
  if (contentType.includes('text/css')) return '.css';
  if (contentType.includes('javascript')) return '.js';
  if (contentType.includes('png')) return '.png';
  if (contentType.includes('jpeg')) return '.jpg';
  if (contentType.includes('gif')) return '.gif';
  if (contentType.includes('svg')) return '.svg';
  return '';
}

function stripTags(value) {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, '')).trim();
}

function decodeHtmlEntities(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeHtmlAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}