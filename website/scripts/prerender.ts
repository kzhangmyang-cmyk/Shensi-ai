import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { paths, localPath, type Locale } from "../src/content";
import { renderPage, pageMeta } from "../src/render";

const pagesBuild = process.env.WEBSITE_BUILD_TARGET === "pages";
const root = fileURLToPath(new URL(pagesBuild ? "../dist-pages/" : "../dist/", import.meta.url));
const template = await readFile(resolve(root, "index.html"), "utf8");
const origin = process.env.WEBSITE_PUBLIC_ORIGIN?.replace(/\/$/, "");
if (origin && (!/^https:\/\/[^/]+$/.test(origin) || new URL(origin).username || new URL(origin).password)) throw new Error("WEBSITE_PUBLIC_ORIGIN must be an HTTPS origin");
const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const urls: string[] = [];
const documents = new Map<string, string>();
for (const locale of ["zh", "en"] as Locale[]) for (const path of paths) {
  const route = localPath(locale, path);
  const meta = pageMeta(route);
  const canonical = origin ? `<link rel="canonical" href="${escape(origin + route)}"/><link rel="alternate" hreflang="zh-CN" href="${escape(origin + path)}"/><link rel="alternate" hreflang="en" href="${escape(origin + localPath("en", path))}"/><link rel="alternate" hreflang="x-default" href="${escape(origin + path)}"/>` : '<meta name="robots" content="noindex,nofollow"/>';
  const html = template.replace('lang="zh-CN"', `lang="${locale === "zh" ? "zh-CN" : "en"}"`).replace(/<title>.*?<\/title>/, `<title>${escape(meta.title)}</title>`).replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${escape(meta.description)}"/>`).replace("</head>", `${canonical}<meta property="og:title" content="${escape(meta.title)}"/><meta property="og:description" content="${escape(meta.description)}"/><meta property="og:type" content="website"/><meta property="og:locale" content="${locale === "zh" ? "zh_CN" : "en_US"}"/></head>`).replace("<!--prerender-->", renderPage(route, { staticContact: pagesBuild }));
  const file = resolve(root, route.slice(1), "index.html");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
  urls.push(route);
  documents.set(route, html);
}
// Validate the entire generated navigation graph, including links on deep pages.
// Fail the build if a clickable route or fragment has no destination.
let checkedLinks = 0;
for (const [route, html] of documents) {
  if (!/<h1\b[^>]*>\s*\S/.test(html)) throw new Error(`Missing page heading: ${route}`);
  for (const match of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) {
    const target = new URL(match[1].replaceAll("&amp;", "&"), `https://website.invalid${route}`);
    if (target.origin !== "https://website.invalid") continue;
    const targetPath = target.pathname.replace(/\/+$/, "") || "/";
    const destination = documents.get(targetPath);
    if (!destination) throw new Error(`Broken link: ${route} -> ${target.pathname}`);
    if (target.hash && !destination.includes(`id="${decodeURIComponent(target.hash.slice(1))}"`)) {
      throw new Error(`Missing anchor: ${route} -> ${target.pathname}${target.hash}`);
    }
    checkedLinks++;
  }
}
console.log(`SHENSI_WEBSITE_LINKS_OK ${checkedLinks} internal links across ${documents.size} pages`);
if (pagesBuild) {
  // A root 404 prevents Pages from treating this multi-page site as an SPA.
  for (const locale of ["zh", "en"] as Locale[]) {
    const missing = localPath(locale, "/not-found");
    const html = template.replace('lang="zh-CN"', `lang="${locale === "zh" ? "zh-CN" : "en"}"`)
      .replace(/<title>.*?<\/title>/, `<title>${escape(pageMeta(missing).title)}</title>`)
      .replace("</head>", '<meta name="robots" content="noindex,nofollow"/></head>')
      .replace("<!--prerender-->", renderPage(missing, { staticContact: true }));
    await writeFile(resolve(root, locale === "en" ? "en/404.html" : "404.html"), html);
  }
  await writeFile(resolve(root, "_headers"), `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n  Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'none'\n${origin ? "" : "  X-Robots-Tag: noindex, nofollow\n"}`);
}
await writeFile(resolve(root,"sitemap.xml"),`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${origin ? urls.map(url=>`<url><loc>${escape(origin+url)}</loc></url>`).join("") : ""}</urlset>`);
await writeFile(resolve(root,"robots.txt"),origin ? `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n` : "User-agent: *\nDisallow: /\n");
console.log(`SHENSI_WEBSITE_PRERENDER_OK ${urls.length} pages; indexing ${origin ? "enabled" : "disabled until public origin is configured"}`);
