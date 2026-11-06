// Builds index.html (English), ko.html, zh.html, ja.html and vi.html from src/template.html.
// Each page is saved with its text already filled in, so Google and AI crawlers can read it
// without running JavaScript. Run from the suzy-website folder:  node src/build.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pages = { en: 'index.html', ko: 'ko.html', zh: 'zh.html', ja: 'ja.html', vi: 'vi.html' };
const alt = Object.entries(pages)
  .map(([l, f]) => `<link rel="alternate" hreflang="${l === 'zh' ? 'zh-Hans' : l}" href="${f}">`)
  .concat('<link rel="alternate" hreflang="x-default" href="index.html">').join('\n');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const [lang, file] of Object.entries(pages)) {
    await page.goto('file://' + path.join(__dirname, 'template.html') + '?lang=' + lang);
    // Remove things the script adds at runtime, so they are not doubled when the page loads.
    const html = await page.evaluate(() => {
      document.querySelectorAll('#social > *, #heroDots > *, #heroSlides .bg, #gmap iframe').forEach(e => e.remove());
      document.querySelectorAll('#heroSlides img.on').forEach(e => e.classList.remove('on'));
      return '<!doctype html>\n' + document.documentElement.outerHTML;
    });
    fs.writeFileSync(path.join(root, file), html.replace('<!--ALT_LINKS-->', alt));
    console.log('built', file);
  }
  await browser.close();
})();
