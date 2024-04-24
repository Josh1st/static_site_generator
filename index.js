const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const urlModule = require('url');
const url = require('url');
const axios = require('axios');
const { log } = require('console');

const visitedUrls = new Set();
const urlMap = {};  // Global mapping of old URLs to new URLs
const baseUrl = 'http://127.0.0.1:5500'; // Replace with your WordPress site URL
// const baseUrl = 'https://salontemplates.webflow.io';
// const baseUrl = 'https://nationalgasinstallers.co.za';
const blockedUrls = []

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function chunkArray(array, size) {
    let result = [];
    for (let value of array) {
        let lastArray = result[result.length - 1];
        if (!lastArray || lastArray.length === size) {
            result.push([value]);
        } else {
            lastArray.push(value);
        }
    }
    return result;
}

async function saveResource(request, folder, url = null) {
    url = url || request.url()
    try {
        if (blockedUrls.includes(url)) {
            return
        }

        if (url.includes('google')) {
            return
        }

        if (url.endsWith('/')) {
            console.warn(`Skipping saving of "${url}" as it seems to be a directory.`);
            return;
        }

        const pathname = new URL(url).pathname;
        const filePath = path.join(folder, pathname.split('/').pop());

        if (fs.existsSync(filePath)) {
            // console.log(`File already exists: ${filePath}. Skipping...`);
        } else {

            let buffer = null;
            if (request == null) {
                let response = await axios.get(url, { responseType: 'arraybuffer' });
                buffer = response.data
            } else {
                try {
                    buffer = await request.response().buffer();
                } catch (error) {
                    console.error(`failed to get response or buffer for ${url}`);
                }
            }

            await fs.writeFile(filePath, buffer);
        }

        // Relative path
        const relativePath = path.relative('./static', filePath);

        urlMap[url] = relativePath;  // Save the new path in the global urlMap
    } catch (error) {
        console.error(`failed to get file: ${url}`);
        blockedUrls.push(url);
    }
}

async function getResourcesFromPage(page) {
    let resources = await page.evaluate(() => {
        let resources = {};

        // JS resources
        const js = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
        resources.js = js

        // CSS resources
        const css = Array.from(document.querySelectorAll('link[rel="stylesheet"]')).map(s => s.href);
        resources.css = css

        // Image resources
        const images = Array.from(document.querySelectorAll('img[src], img[data-src]')).map(img => img.src || img.dataset.src);
        resources.images = images

        // Image resources from srcset
        const srcsets = Array.from(document.querySelectorAll('*[srcset]')).map(img => img.srcset).flatMap(srcset => srcset.split(',').map(s => s.trim().split(/\s+/)[0]));
        resources.images = resources.images.concat(srcsets);

        var absolutePath = function (href) {
            var link = document.createElement("a");
            link.href = href;
            return link.href;
        }

        for (const [key, links] of Object.entries(resources)) {
            for (let i = 0; i < links.length; i++) {
                let link = links[i];
                resources[key][i] = absolutePath(link)
            }
        }

        return resources;
    });

    const promises = [];

    for (const [key, links] of Object.entries(resources)) {
        for (let i = 0; i < links.length; i++) {
            const link = links[i];
            if (!visitedUrls.has(link)) {
                promises.push(saveResource(null, `./static/static/${key}`, link))
            }
        }
    }
    await Promise.all(promises)
}

function escapeRegExp(string) {
    return string.replace(/[.*+\-?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string
}

// Function to rewrite URLs in content (HTML, CSS, JS)
function rewriteContent(content) {

    let _baseUrl = baseUrl
    if (!_baseUrl.endsWith('/')) {
        _baseUrl = `${_baseUrl}/`
    }

    for (let [oldUrl, newPath] of Object.entries(urlMap)) {


        // Replace \ with /
        newPath = newPath.replace(new RegExp('\\\\', 'g'), '/');
        newPath = newPath.replace(/\/\//g, '/'); // Replace double slashes with a single slash
        // Ensure exactly one leading /
        if (!newPath.startsWith('/')) {
            newPath = `/${newPath}`; // Ensure it starts with a single slash
        }

        // Replace absolute URLs
        content = content.replace(new RegExp(escapeRegExp(oldUrl), 'g'), newPath);

        // Replace relative URLs
        const parsedUrl = url.parse(oldUrl);
        const relativePath = parsedUrl.pathname + (parsedUrl.search || '') + (parsedUrl.hash || '');
        // console.log(`Replacing: ${relativePath} -> ${newPath}`);
        
        // Handle relative paths without leading /
        if (relativePath.startsWith('/')) {
            content = content.replace(new RegExp(escapeRegExp(relativePath.slice(1)), 'g'), newPath.slice(1));
        } else {
            content = content.replace(new RegExp(escapeRegExp(relativePath), 'g'), newPath);
        }
    }

    // Make absolute URLs relative
    content = content.replace(new RegExp(escapeRegExp(_baseUrl), 'g'), '/');

    return content;
}

// Function to make links to other pages relative
async function makeLinksRelative(page, baseUrl) {
    await page.evaluate((baseUrl) => {
        document.querySelectorAll('a[href^="' + baseUrl + '"]').forEach(a => {
            a.href = a.href.replace(baseUrl, '/');
        });
    }, baseUrl);
}

async function crawlPage(browser, url, baseUrl) {
    // Skip if already visited
    if (visitedUrls.has(url)) {
        return;
    }

    visitedUrls.add(url);

    const page = await browser.newPage();

    // Handle resources
    page.on('response', async (response) => {
        const request = response.request();
        const resourceType = request.resourceType();
        const requestUrl = request.url();

        if (resourceType === 'stylesheet') {
            await saveResource(request, './static/static/css');
        } else if (resourceType === 'script') {
            await saveResource(request, './static/static/js');
        } else if (resourceType === 'image') {
            await saveResource(request, './static/static/images');
        } else if (resourceType === 'media') {
            await saveResource(request, './static/static/media');
        } else if (resourceType === 'font') {
            await saveResource(request, './static/static/fonts');
        } else if (resourceType === 'manifest') {
            await saveResource(request, './static/static/manifest');
        }
    });

    try {
        await page.goto(url, { waitUntil: ['domcontentloaded', 'networkidle2'], timeout: 10000 });
        await sleep(6000);
    } catch (error) {
        console.log(`Failed to load ${url}: ${error.message}`);

        try {
            await page.goto(url, { timeout: 10000 });
            await sleep(6000); // wait for 5 seconds
        } catch (error) {
            console.log(`Something is seriously wrong ${url}: ${error.message}`);
            await page.close();
            return;
        }
    }

    await getResourcesFromPage(page)

    // Collect and visit all internal links
    let internalLinks = [];

    try {
        internalLinks = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a'))
                .map(a => a.href)
                .filter(href => {
                    // Ensure the link starts with the current origin
                    const startsWithOrigin = href.startsWith(window.location.origin);
                    // Check if it's an anchor link (like #top)
                    const isAnchorLink = href.split('#').length > 1 && href.split('#')[1] !== '';
                    return startsWithOrigin && !isAnchorLink;
                });
        });
    } catch (error) {
        console.log(`Failed to evaluate internal links on ${url}: ${error.message}`);
    }

    // Make page links relative
    await makeLinksRelative(page, baseUrl);

    // Save HTML
    // get the html like it is from the source, without hydration
    let content;
    try {
        let response = await axios.get(url);
        content = response.data;
    } catch (error) {
        content = await page.content();
    }

    const parsedUrl = urlModule.parse(url);
    let filePath = parsedUrl.pathname;

    // Check if filePath ends with .html
    if (filePath.endsWith('.html')) {
        filePath = filePath.substring(0, filePath.length - 5); // Strip .html from the end
    } else if (!filePath.endsWith('/')) {
        filePath = `${filePath}/`; // Ensure it ends with /
    }

    const fullFilePath = path.join('./static', filePath, 'index.html');
    await fs.ensureDir(path.dirname(fullFilePath));
    await fs.writeFile(fullFilePath, content);

    await page.close();

    async function crawlInternalLinks(browser, internalLinks, baseUrl) {
        // Check the number of open pages
        const openPages = await browser.pages();
        const numberOfOpenPages = openPages.length;

        let chunkSize = 3;
        if (numberOfOpenPages > 3) {
            chunkSize = 1;
        } else{
            chunkSize = 3;
        }

        const linkChunks = chunkArray(internalLinks, chunkSize);

        for (const chunk of linkChunks) {
            const promises = chunk.map(link => crawlPage(browser, link, baseUrl));
            await Promise.all(promises);
        }
    }

    await crawlInternalLinks(browser, internalLinks, baseUrl);

}

const getFilesWithExtension = (dir, ext) => {
    let results = [];

    const list = fs.readdirSync(dir);
    list.forEach((file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);

        if (stat && stat.isDirectory()) {
            results = results.concat(getFilesWithExtension(filePath, ext));
        } else {
            if (path.extname(file) === ext) {
                results.push(filePath);
            }
        }
    });

    return results;
};

// After crawling is complete, rewrite HTML, CSS, and JS files
async function rewriteAllSavedFiles() {
    const htmlFiles = getFilesWithExtension('./static', '.html');  // Collect paths to saved HTML files
    const cssFiles = getFilesWithExtension('./static/static/css', '.css');   // Collect paths to saved CSS files
    const jsFiles = getFilesWithExtension('./static/static/js', '.js');    // Collect paths to saved JS files

    // Rewrite and save HTML files
    for (const filePath of htmlFiles) {
        let content = await fs.readFile(filePath, 'utf8');
        content = rewriteContent(content);
        await fs.writeFile(filePath, content);
    }

    // Rewrite and save CSS files
    for (const filePath of cssFiles) {
        let content = await fs.readFile(filePath, 'utf8');
        content = rewriteContent(content);
        await fs.writeFile(filePath, content);
    }

    // Rewrite and save JS files
    for (const filePath of jsFiles) {
        let content = await fs.readFile(filePath, 'utf8');
        content = rewriteContent(content);
        await fs.writeFile(filePath, content);
    }
}

async function main() {
    const browser = await puppeteer.launch({ headless: false });

    fs.ensureDirSync('./static/static/css');
    fs.ensureDirSync('./static/static/js');
    fs.ensureDirSync('./static/static/images');
    fs.ensureDirSync('./static/static/media');
    fs.ensureDirSync('./static/static/fonts');
    fs.ensureDirSync('./static/static/manifest');

    await crawlPage(browser, baseUrl, baseUrl);

    await browser.close();
    await rewriteAllSavedFiles(baseUrl);
    fs.writeFileSync(path.resolve(__dirname, 'urls.json'), JSON.stringify(urlMap));
}

main().catch(console.error);