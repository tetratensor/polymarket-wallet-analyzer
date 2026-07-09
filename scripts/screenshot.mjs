// Visual smoke test: loads the dashboard, runs an analysis, screenshots the result.
import puppeteer from 'puppeteer-core';

const WALLET = process.argv[2] || '0xb1feb9fe351c9e5fbc372c6a49b7fe5bdd9608d2';
const browser = await puppeteer.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: 'new',
  args: ['--no-sandbox'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

await page.goto('http://localhost:3000', { waitUntil: 'networkidle0' });
await page.type('#wallet', WALLET);
await page.click('#go');
await page.waitForSelector('#results:not(.hidden)', { timeout: 180000 });
await new Promise((r) => setTimeout(r, 2500));

await page.screenshot({ path: 'scripts/screenshot-top.png' });
await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
await new Promise((r) => setTimeout(r, 800));
await page.screenshot({ path: 'scripts/screenshot-bottom.png' });

// switch to inferred timezone view if enabled
const inferredEnabled = await page.evaluate(() => !document.querySelector('#tzmode option[value="inferred"]').disabled);
if (inferredEnabled) {
  await page.select('#tzmode', 'inferred');
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => window.scrollTo(0, 0));
  await new Promise((r) => setTimeout(r, 500));
  await page.screenshot({ path: 'scripts/screenshot-inferred.png' });
}

console.log('JS errors:', errors.length ? errors : 'none');
await browser.close();
