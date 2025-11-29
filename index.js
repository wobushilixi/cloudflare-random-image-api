/**
 * 李喜的随机API图床 - V13 自动化运维版 (完整版 - 无省略)
 * 增强：
 * 1. 链接追加模式：新链接自动追加，不覆盖。
 * 2. 分页管理：管理面板支持链接分页、切换每页大小。
 * 3. 批量删除：支持当前页全选和批量删除。
 * 4. 自动化维护：新增 scheduled handler，支持 Cloudflare Cron Triggers 自动清理失效链接。
 */

const PATH_API_BASE = '/api';
const PATH_ADMIN = '/admin';
const PATH_DOCS = '/docs';
const PATH_NO_IMAGE = '/no-image'; 
const PATH_TAGS_LIST = '/tags'; 
const KEY_IMAGE_LIST = 'images_list';
const KEY_API_HITS = 'api_hits';
const PROJECT_NAME = "随机背景图 API";
const DEFAULT_TAG = "default"; 
const RATIO_TOLERANCE = 0.05;

// --- UTILITIES ---

async function isAuthenticated(request, env) {
    const cookieHeader = request.headers.get('Cookie');
    if (!cookieHeader) return false;
    const cookies = Object.fromEntries(cookieHeader.split(';').map(c => {
        const [key, value] = c.trim().split('=');
        return [key, value];
    }));
    const token = cookies['session_token'];
    if (!token) return false;
    const sessionData = await env.IMAGE_LINKS.get(`session_${token}`);
    return sessionData === 'valid';
}

function createSessionCookie(token, expirySeconds) {
    const expires = new Date(Date.now() + expirySeconds * 1000).toUTCString();
    return `session_token=${token}; Expires=${expires}; HttpOnly; Secure; SameSite=Strict; Path=/`;
}

function clearSessionCookie() {
    return `session_token=deleted; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; Secure; SameSite=Strict; Path=/`;
}

function isValidUrl(url) {
    return url && (url.startsWith('http://') || url.startsWith('https://'));
}

function parseRatio(ratioString) {
    const parts = ratioString.split(':');
    if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1]) && parts[1] !== '0') {
        return parseFloat(parts[0]) / parseFloat(parts[1]);
    }
    return null;
}

// --- API & CORE LOGIC HANDLERS ---

async function selectRandomImage(request, env) {
    const url = new URL(request.url);
    const desiredTag = url.searchParams.get('tag');
    const desiredRatioString = url.searchParams.get('ratio');
    const desiredRatio = desiredRatioString ? parseRatio(desiredRatioString) : null;

    const listJson = await env.IMAGE_LINKS.get(KEY_IMAGE_LIST);
    const allLinks = listJson ? JSON.parse(listJson) : [];

    if (allLinks.length === 0) {
        return { selectedItem: null, allLinksAvailable: false };
    }
    
    let filteredLinks = allLinks;

    if (desiredTag) {
        filteredLinks = filteredLinks.filter(item => item.tag === desiredTag);
    }

    if (desiredRatio !== null) {
        const ratioFiltered = filteredLinks.filter(item => 
            item.width > 0 && 
            item.height > 0 && 
            Math.abs(item.ratio - desiredRatio) <= RATIO_TOLERANCE
        );
        if (ratioFiltered.length > 0) {
            filteredLinks = ratioFiltered;
        } 
    }
    
    const linksToUse = filteredLinks.length > 0 ? filteredLinks : allLinks;
    
    const randomIndex = Math.floor(Math.random() * linksToUse.length);
    const selectedItem = linksToUse[randomIndex];

    return { selectedItem: selectedItem, allLinksAvailable: true };
}


/**
 * GET /api: 随机图片重定向 API 
 */
async function handleRandomRedirect(request, env) {
    const currentHits = parseInt(await env.IMAGE_LINKS.get(KEY_API_HITS) || 0);
    await env.IMAGE_LINKS.put(KEY_API_HITS, (currentHits + 1).toString());

    try {
        const { selectedItem, allLinksAvailable } = await selectRandomImage(request, env);

        if (!allLinksAvailable) {
             const redirectUrl = new URL(PATH_NO_IMAGE, new URL(request.url).origin);
             return new Response(null, { status: 302, headers: { 'Location': redirectUrl.toString() } });
        }
        
        const headers = {
            'Location': selectedItem.url,
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0',
            'X-Image-Tag': selectedItem.tag || DEFAULT_TAG,
            'X-Image-Dimensions': selectedItem.width && selectedItem.height ? `${selectedItem.width}x${selectedItem.height}` : 'unknown'
        };

        return new Response(null, { status: 302, headers: headers });

    } catch (e) {
        return new Response(JSON.stringify({ success: false, message: `Internal Server Error in API: ${e.message}` }), { status: 500 });
    }
}

/**
 * GET /api/info: 随机图片信息 JSON 模式
 */
async function handleImageInfo(request, env) {
    try {
        const { selectedItem, allLinksAvailable } = await selectRandomImage(request, env);

        if (!allLinksAvailable) {
             return new Response(JSON.stringify({ success: false, message: "No images available in database." }), { status: 404 });
        }
        
        return new Response(JSON.stringify({
            success: true,
            image: {
                url: selectedItem.url,
                tag: selectedItem.tag,
                width: selectedItem.width,
                height: selectedItem.height,
                aspectRatio: selectedItem.ratio.toFixed(2) 
            }
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (e) {
        return new Response(JSON.stringify({ success: false, message: `Internal Server Error: ${e.message}` }), { status: 500 });
    }
}


/**
 * POST /api/upload: 更新链接列表（核心逻辑：替换，供导入功能使用）
 */
async function handleImageUpdate(request, env) {
    if (!await isAuthenticated(request, env)) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401 });
    }
    const linksArray = await request.json(); 
    
    if (!Array.isArray(linksArray)) {
        return new Response(JSON.stringify({ success: false, message: "Invalid input format. Expected an array." }), { status: 400 });
    }

    const uniqueUrls = new Set();
    const finalLinks = [];

    for (const item of linksArray) {
        if (!item || !isValidUrl(item.url)) continue;
        
        const normalizedUrl = item.url.trim();
        if (uniqueUrls.has(normalizedUrl)) continue;

        uniqueUrls.add(normalizedUrl);
        
        const width = item.width || 0;
        const height = item.height || 0;

        finalLinks.push({
            url: normalizedUrl,
            tag: (item.tag || DEFAULT_TAG).trim().toLowerCase().replace(/\s/g, '_'),
            width: width,
            height: height,
            ratio: (width > 0 && height > 0) ? (width / height) : 0
        });
    }

    try {
        await env.IMAGE_LINKS.put(KEY_IMAGE_LIST, JSON.stringify(finalLinks));
        return new Response(JSON.stringify({ success: true, message: `Image list replaced successfully. Stored ${finalLinks.length} unique links.`, count: finalLinks.length }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ success: false, message: `Storage error.` }), { status: 500 });
    }
}


/**
 * POST /api/append: 追加链接列表（V12 核心：追加）
 */
async function handleImageAppend(request, env) {
    if (!await isAuthenticated(request, env)) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401 });
    }
    const newLinksArray = await request.json(); 
    
    if (!Array.isArray(newLinksArray)) {
        return new Response(JSON.stringify({ success: false, message: "Invalid input format. Expected an array." }), { status: 400 });
    }

    const listJson = await env.IMAGE_LINKS.get(KEY_IMAGE_LIST);
    let allLinks = listJson ? JSON.parse(listJson) : [];
    
    const existingUrls = new Set(allLinks.map(item => item.url));
    let addedCount = 0;

    for (const item of newLinksArray) {
        if (!item || !isValidUrl(item.url)) continue;
        
        const normalizedUrl = item.url.trim();
        if (existingUrls.has(normalizedUrl)) continue;

        existingUrls.add(normalizedUrl);
        addedCount++;
        
        const width = item.width || 0;
        const height = item.height || 0;

        allLinks.push({
            url: normalizedUrl,
            tag: (item.tag || DEFAULT_TAG).trim().toLowerCase().replace(/\s/g, '_'),
            width: width,
            height: height,
            ratio: (width > 0 && height > 0) ? (width / height) : 0
        });
    }

    try {
        await env.IMAGE_LINKS.put(KEY_IMAGE_LIST, JSON.stringify(allLinks));
        return new Response(JSON.stringify({ success: true, message: `Successfully added ${addedCount} new links. Total links: ${allLinks.length}.`, count: allLinks.length }), {
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ success: false, message: `Storage error.` }), { status: 500 });
    }
}


/**
 * POST /api/batch_delete: 批量删除链接
 */
async function handleImageBatchDelete(request, env) {
    if (!await isAuthenticated(request, env)) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401 });
    }
    const { urlsToDelete } = await request.json();
    
    if (!Array.isArray(urlsToDelete) || urlsToDelete.length === 0) {
        return new Response(JSON.stringify({ success: false, message: "Invalid or empty URL array provided." }), { status: 400 });
    }

    const listJson = await env.IMAGE_LINKS.get(KEY_IMAGE_LIST);
    const allLinks = listJson ? JSON.parse(listJson) : [];
    
    const urlsToDeleteSet = new Set(urlsToDelete.map(url => url.trim()));
    const initialCount = allLinks.length;
    
    const newLinks = allLinks.filter(item => !urlsToDeleteSet.has(item.url.trim()));
    
    const deletedCount = initialCount - newLinks.length;
    
    if (deletedCount === 0) {
        return new Response(JSON.stringify({ success: false, message: "None of the provided URLs were found." }), { status: 404 });
    }
    
    await env.IMAGE_LINKS.put(KEY_IMAGE_LIST, JSON.stringify(newLinks));
    return new Response(JSON.stringify({ success: true, message: `Successfully deleted ${deletedCount} links. Remaining: ${newLinks.length}.` }), {
        headers: { 'Content-Type': 'application/json' }
    });
}


/**
 * GET /api/export: 导出所有链接数据
 */
async function handleImageExport(request, env) {
    if (!await isAuthenticated(request, env)) {
        return new Response("Unauthorized", { status: 401 });
    }

    const listJson = await env.IMAGE_LINKS.get(KEY_IMAGE_LIST);
    const links = listJson || '[]';
    
    return new Response(links, {
        headers: {
            'Content-Type': 'application/json',
            'Content-Disposition': `attachment; filename="image_links_backup_${new Date().toISOString().slice(0, 10)}.json"`
        }
    });
}

/**
 * GET /api/list: 获取所有链接列表及统计信息
 */
async function handleImageList(request, env) {
    if (!await isAuthenticated(request, env)) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401 });
    }
    const listJson = await env.IMAGE_LINKS.get(KEY_IMAGE_LIST);
    const links = listJson ? JSON.parse(listJson) : [];
    
    const totalHits = parseInt(await env.IMAGE_LINKS.get(KEY_API_HITS) || 0);

    return new Response(JSON.stringify({ success: true, links: links, totalHits: totalHits }), {
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * CORE LOGIC / 核心维护逻辑
 * POST /api/maintenance: 运行维护检查 (现在也供定时器使用)
 * 接收 request 用于 HTTP 触发，如果为 null 则为 scheduled 触发
 */
async function handleMaintenance(request, env) {
    // 只有在通过 HTTP 请求 (例如通过 /admin 面板) 触发时才检查身份验证
    if (request && !await isAuthenticated(request, env)) {
        return new Response(JSON.stringify({ success: false, message: "Unauthorized" }), { status: 401 });
    }

    const listJson = await env.IMAGE_LINKS.get(KEY_IMAGE_LIST);
    const allLinks = listJson ? JSON.parse(listJson) : [];
    const validLinks = [];
    const checkPromises = [];
    
    // 异步并发检查所有链接
    for (const item of allLinks) {
        checkPromises.push((async () => {
            try {
                // 使用 HEAD 请求检查链接有效性，设置较短超时（防止任务阻塞）
                const response = await fetch(item.url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(5000) }); // 5秒超时
                if (response.ok || (response.status >= 300 && response.status < 400)) {
                    validLinks.push(item);
                }
            } catch (e) {
                // 忽略 fetch 错误，认为链接失效 (如超时、DNS 失败等)
            }
        })());
    }

    await Promise.all(checkPromises);
    
    const removedCount = allLinks.length - validLinks.length;
    await env.IMAGE_LINKS.put(KEY_IMAGE_LIST, JSON.stringify(validLinks));
    
    const result = { 
        success: true, 
        message: `Maintenance finished. Total links removed: ${removedCount}. Remaining: ${validLinks.length}.` 
    };

    // 如果是通过 HTTP 请求触发 (有 request 对象)，返回 JSON 响应
    if (request) {
        return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
    }
    
    // 如果是通过定时器触发 (无 request 对象)，返回核心结果
    return result;
}

/**
 * POST /api/login: 管理员登录
 */
async function handleLogin(request, env) {
    const { username, password } = await request.json();
    if (username === env.ADMIN_USERNAME && password === env.ADMIN_PASSWORD) {
        const token = crypto.randomUUID(); 
        await env.IMAGE_LINKS.put(`session_${token}`, 'valid', { expirationTtl: env.SESSION_EXPIRY_SECONDS });
        return new Response(JSON.stringify({ success: true, message: "Login successful" }), {
            headers: { 
                'Content-Type': 'application/json',
                'Set-Cookie': createSessionCookie(token, env.SESSION_EXPIRY_SECONDS || 3600)
            },
        });
    } else {
        return new Response(JSON.stringify({ success: false, message: "Invalid credentials" }), {
            status: 401, 
            headers: { 'Content-Type': 'application/json' }
        });
    }
}


// --- FRONTEND HANDLERS (HTML & Style) ---

const MINIMAL_STYLE = `
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@300;400;500;700&display=swap');
    
    :root {
        --color-bg: #f5f5f7; 
        --color-surface: #ffffff; 
        --color-text: #1d1d1f; 
        --color-secondary-text: #6e6e73; 
        --color-primary: #0071e3; 
        --color-accent: #1d1d1f; 
        --color-success: #34c759;
        --color-error: #ff3b30;
        --shadow-mid: 0 4px 6px rgba(0,0,0,0.05), 0 1px 3px rgba(0,0,0,0.1);
        --transition-base: 0.3s cubic-bezier(0.25, 0.1, 0.25, 1);
    }

    body {
        font-family: 'Noto Sans SC', sans-serif;
        background-color: var(--color-bg);
        color: var(--color-text);
        padding: 0; margin: 0;
        display: flex; justify-content: center; align-items: center; min-height: 100vh;
        line-height: 1.5;
    }
    .header { 
        position: fixed; top: 0; width: 100%; max-width: 1100px;
        padding: 15px 50px; display: flex; justify-content: space-between; align-items: center;
        z-index: 20; background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(8px);
    }
    .header a { text-decoration: none; color: var(--color-text); font-weight: 500; padding: 5px 10px; border-radius: 6px; transition: background var(--transition-base); }
    .header a:hover { background: #f0f0f5; }
    .container {
        width: 100%; max-width: 1100px;
        background: var(--color-surface);
        padding: 50px;
        border-radius: 12px;
        box-shadow: var(--shadow-mid);
        margin: 30px;
        animation: fadeIn var(--transition-base) forwards;
    }
    h1, h2, h3 { font-weight: 600; color: var(--color-accent); margin-top: 0; }
    h1 { font-size: 2.5em; border-bottom: 1px solid #e3e3e3; padding-bottom: 15px; margin-bottom: 30px; }
    
    /* Form & Input Styles */
    input[type="text"], input[type="password"], textarea, select {
        width: 100%; padding: 12px; margin: 10px 0; display: inline-block;
        border: 1px solid #dcdcdc; border-radius: 8px; box-sizing: border-box;
        background: var(--color-surface); color: var(--color-text);
        font-size: 1em;
        transition: border-color var(--transition-base), box-shadow var(--transition-base);
    }
    textarea { resize: vertical; min-height: 150px; }

    /* Button Styles */
    button {
        background-color: var(--color-primary); color: var(--color-surface);
        padding: 10px 20px; margin: 10px 10px 10px 0; border: none;
        border-radius: 999px; cursor: pointer; font-weight: 500; font-size: 1em;
        transition: background-color var(--transition-base), transform 0.1s, opacity var(--transition-base);
        min-width: 120px;
    }
    button:hover { background-color: #0077ff; }
    .secondary-btn { background-color: #e5e5e5; color: var(--color-text); }
    .secondary-btn:hover { background-color: #dcdcdc; }
    .delete-btn { background-color: var(--color-error); min-width: 80px; padding: 5px 10px; margin: 0; }
    .delete-btn:hover { background-color: #f00; }
    
    /* Status & Stats */
    .stats { display: flex; gap: 30px; margin-bottom: 30px; padding: 15px 0; border-top: 1px solid #eee; border-bottom: 1px solid #eee; }
    .stats span strong { color: var(--color-accent); font-size: 1.1em; }
    .status-msg { margin-top: 15px; padding: 10px; border-radius: 6px; font-weight: 500; opacity: 0; }
    .status-success { background-color: #f1f8e9; color: var(--color-success); animation: slideIn 0.5s forwards; }
    .status-error { background-color: #ffebee; color: var(--color-error); animation: slideIn 0.5s forwards; }
    .status-info { background-color: #e3f2fd; color: var(--color-primary); animation: slideIn 0.5s forwards; }
    
    /* Table & List Styles */
    .admin-table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 0.9em; }
    .admin-table th, .admin-table td { text-align: left; padding: 12px; border-bottom: 1px solid #e9e9e9; vertical-align: middle; }
    .admin-table th { background-color: #f8f8f8; font-weight: 600; color: var(--color-accent); }
    .preview-cell { width: 80px; height: 50px; background-size: cover; background-position: center; border-radius: 4px; border: 1px solid #eee; }
    .tag-item { background: #e3f2fd; color: var(--color-primary); padding: 3px 8px; border-radius: 4px; font-weight: 500; white-space: nowrap; }

    /* V12 New Styles for Admin */
    .pagination-controls { 
        display: flex; justify-content: space-between; align-items: center; 
        margin-top: 20px; padding: 10px 0; border-top: 1px solid #eee; 
    }
    .pagination-controls button {
        min-width: auto; padding: 8px 15px; margin: 0 5px;
    }
    .pagination-info { font-size: 0.9em; color: var(--color-secondary-text); }
    .select-group { display: flex; align-items: center; gap: 10px; }
    .select-group select { width: auto; min-width: 80px; margin: 0; padding: 8px; }
    .tool-section { margin-top: 40px; border-top: 1px solid #eee; padding-top: 20px; }
    .import-area { border: 2px dashed #ddd; padding: 20px; border-radius: 8px; text-align: center; margin-bottom: 10px; }
    .import-area.dragover { border-color: var(--color-primary); background-color: #f8fbff; }
    .file-input-label { cursor: pointer; color: var(--color-primary); font-weight: 500; text-decoration: underline; display: inline-block; margin-top: 10px;}
    .api-link-box {
        margin: 20px auto 10px; 
        max-width: 400px;
        display: flex; 
        align-items: center; 
        justify-content: center;
        background-color: #f0f0f5; 
        border-radius: 8px; 
        padding: 10px;
        transition: box-shadow var(--transition-base);
    }
    .copy-btn { 
        background: none; 
        color: var(--color-primary); 
        padding: 5px; 
        margin: 0 0 0 10px;
        border: none;
        min-width: 0;
        font-size: 0.9em;
        font-weight: 500;
    }
    .copy-btn:hover { text-decoration: underline; background: none; }
`;


/**
 * GET /admin: 管理员面板 (V12：分页、追加模式、批量删除)
 */
async function handleAdminPanel(request, env) {
    const baseUrl = new URL(request.url).origin;
    const apiUrlBase = `${baseUrl}/api`;
    const authenticated = await isAuthenticated(request, env);
    
    let content;
    if (authenticated) {
        // --- 已登录管理面板 (V12 SPA 优化) ---
        content = `
            <h2>链接管理终端</h2>
            <div class="stats">
                <span>链接总数: <strong><span id="linkCount">0</span></strong></span>
                <span>API 总调用: <strong><span id="hitCount">0</strong></span>
                <span>筛选标签: 
                    <select id="tagSelect" onchange="renderLinks(currentFilteredLinks, 1)">
                        <option value="all">所有链接</option>
                    </select>
                </span>
            </div>
            
            <h3 style="margin-top: 50px;">批量添加链接</h3>
            <p>请按格式输入**新的**链接，将自动追加到现有列表，并自动尝试获取分辨率。已存在的链接将被跳过。</p>
            <textarea id="linksTextarea" rows="10" placeholder="[图片URL] | [标签名] \n示例：\nhttps://example.com/new_moe.jpg | character\nhttps://example.com/new_sky.png | scenery"></textarea>
            
            <div class="actions">
                <button onclick="appendLinks()">添加链接</button> 
                <button onclick="fetchLinks()" class="secondary-btn">刷新列表</button>
                <button onclick="logout()" class="secondary-btn" style="float: right;">登出</button>
                <button onclick="runMaintenance()" class="secondary-btn" style="float: right; margin-right: 0;">运行维护检查</button>
            </div>

            <div id="statusMessage" class="status-msg"></div>

            <div class="tool-section">
                <h3>数据工具 (导入/导出)</h3>

                <p>点击下方按钮，导出当前全部链接数据 JSON 文件作为备份：</p>
                <button onclick="exportLinks()" class="secondary-btn">导出当前链接列表 (.json)</button>
                
                <p style="margin-top: 30px;">您也可以通过 JSON 导入（导入将**覆盖**现有列表）：</p>
                <div class="import-area" id="dropArea">
                    <p>将 JSON 文件拖拽到此处，或</p>
                    <input type="file" id="jsonFileInput" accept=".json" style="display: none;">
                    <label for="jsonFileInput" class="file-input-label">点击选择文件</label>
                </div>
                <button onclick="importLinks()" class="secondary-btn" style="min-width: 150px; margin-right: 0;">开始导入并覆盖当前列表</button>
                <textarea id="importTextarea" rows="5" placeholder="或者直接粘贴 JSON 内容..." style="margin-top: 10px;"></textarea>
            </div>


            <h3 style="margin-top: 50px;">当前链接列表 (${PROJECT_NAME})</h3>
            
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;">
                <div>
                    <input type="checkbox" id="selectAllCheckbox" onchange="toggleSelectAll(this.checked)">
                    <label for="selectAllCheckbox">全选当前页链接</label>
                </div>
                <button class="delete-btn" style="margin: 0; min-width: 100px;" onclick="batchDeleteLinks()">批量删除选中链接</button>
            </div>

            <div id="linksTableContainer">
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th style="width: 20px;"></th>
                            <th>预览</th>
                            <th>链接 (URL)</th>
                            <th>标签 (Tag)</th>
                            <th>分辨率 (WxH)</th>
                            <th>比例 (Ratio)</th>
                            <th>操作</th>
                        </tr>
                    </thead>
                    <tbody id="linksTableBody">
                        <tr><td colspan="7" style="text-align: center;">点击 "刷新列表" 获取数据...</td></tr>
                    </tbody>
                </table>
            </div>

            <div class="pagination-controls">
                <div class="select-group">
                    <span>每页显示:</span>
                    <select id="pageSizeSelect" onchange="changePageSize(this.value)">
                        <option value="10">10</option>
                        <option value="20">20</option>
                        <option value="50">50</option>
                        <option value="100">100</option>
                    </select>
                </div>
                <div>
                    <button onclick="goToPage(currentPage - 1)">上一页</button>
                    <span id="paginationInfo" class="pagination-info">页 1 / 总 1</span>
                    <button onclick="goToPage(currentPage + 1)">下一页</button>
                </div>
            </div>
            
            <script>
                const textarea = document.getElementById('linksTextarea');
                const importTextarea = document.getElementById('importTextarea');
                const status = document.getElementById('statusMessage');
                const linkCountSpan = document.getElementById('linkCount');
                const hitCountSpan = document.getElementById('hitCount');
                const tagSelect = document.getElementById('tagSelect');
                const linksTableBody = document.getElementById('linksTableBody');
                const jsonFileInput = document.getElementById('jsonFileInput');
                const dropArea = document.getElementById('dropArea');
                const pageSizeSelect = document.getElementById('pageSizeSelect');
                const paginationInfo = document.getElementById('paginationInfo');
                const selectAllCheckbox = document.getElementById('selectAllCheckbox');
                
                let fullLinkList = []; // 所有原始链接
                let currentFilteredLinks = []; // 当前筛选后的链接 (用于分页)
                let currentPage = 1;
                let pageSize = parseInt(pageSizeSelect.value); // 默认 10
                let importedFileContent = null; 

                // --- 通用函数 ---
                function updateStatus(msg, type = 'info') {
                    status.textContent = msg;
                    status.className = 'status-msg status-' + type;
                    status.style.opacity = 1;
                }

                function updateTagSelector(links) {
                    const tags = new Set();
                    links.forEach(item => tags.add(item.tag));
                    
                    const currentSelectedTag = tagSelect.value;
                    tagSelect.innerHTML = '<option value="all">所有链接</option>';

                    tags.forEach(tag => {
                        const option = document.createElement('option');
                        option.value = tag;
                        option.textContent = tag;
                        tagSelect.appendChild(option);
                    });
                    
                    if (tags.has(currentSelectedTag) || currentSelectedTag === 'all') {
                        tagSelect.value = currentSelectedTag;
                    }
                }
                
                // --- V12 分页渲染函数 ---
                function renderLinks(links, page = 1) {
                    const selectedTag = tagSelect.value;
                    
                    // 1. 筛选链接 (仅在 tag 改变时执行，否则使用 currentFilteredLinks)
                    if (links !== currentFilteredLinks) {
                        currentFilteredLinks = selectedTag === 'all' 
                            ? fullLinkList 
                            : fullLinkList.filter(item => item.tag === selectedTag);
                    }

                    const totalItems = currentFilteredLinks.length;
                    const totalPages = Math.ceil(totalItems / pageSize);

                    currentPage = Math.max(1, Math.min(page, totalPages || 1));

                    const startIndex = (currentPage - 1) * pageSize;
                    const endIndex = startIndex + pageSize;
                    const displayLinks = currentFilteredLinks.slice(startIndex, endIndex);

                    // 2. 更新 UI 信息
                    linkCountSpan.textContent = totalItems;
                    paginationInfo.textContent = \`页 \${currentPage} / 总 \${totalPages}\`;
                    selectAllCheckbox.checked = false; 

                    // 3. 渲染表格
                    linksTableBody.innerHTML = ''; 
                    
                    if (totalItems === 0) {
                        linksTableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--color-secondary-text);">无图片链接。</td></tr>';
                        return;
                    }

                    displayLinks.forEach((item, index) => {
                        const tr = document.createElement('tr');
                        
                        tr.innerHTML = \`
                            <td><input type="checkbox" class="link-checkbox" data-url="\${item.url}"></td>
                            <td>
                                <div class="preview-cell" style="background-image: url('\${item.url}')"></div>
                            </td>
                            <td><a href="\${item.url}" target="_blank" title="\${item.url}">\${item.url.substring(0, 40)}...</a></td>
                            <td><span class="tag-item">\${item.tag}</span></td>
                            <td>\${item.width}x\${item.height}</td>
                            <td>\${item.ratio > 0 ? item.ratio.toFixed(2) : '-'}</td>
                            <td>
                                <button class="delete-btn" onclick="batchDeleteLinks(['\${item.url}'])">删除</button>
                            </td>
                        \`;
                        linksTableBody.appendChild(tr);
                    });
                }

                // --- V12 分页控制函数 ---
                function changePageSize(size) {
                    pageSize = parseInt(size);
                    renderLinks(currentFilteredLinks, 1); // 切换大小后回到第一页
                }
                
                function goToPage(page) {
                    if (page < 1 || page > Math.ceil(currentFilteredLinks.length / pageSize)) {
                        return; // 越界阻止
                    }
                    renderLinks(currentFilteredLinks, page);
                }

                function toggleSelectAll(checked) {
                    const checkboxes = linksTableBody.querySelectorAll('.link-checkbox');
                    checkboxes.forEach(cb => {
                        cb.checked = checked;
                    });
                }


                // --- V12 批量删除 ---
                async function batchDeleteLinks(urls = null) {
                    let urlsToDelete;
                    
                    if (urls) {
                        urlsToDelete = urls; // 单个删除传入
                    } else {
                        // 批量删除
                        const checkboxes = linksTableBody.querySelectorAll('.link-checkbox:checked');
                        urlsToDelete = Array.from(checkboxes).map(cb => cb.dataset.url);
                    }

                    if (urlsToDelete.length === 0) {
                        updateStatus('未选中任何链接进行删除。', 'error');
                        return;
                    }
                    
                    if (!confirm(\`确定删除这 \${urlsToDelete.length} 个链接吗？此操作不可撤销。\`)) return;

                    updateStatus('正在批量删除链接...', 'info');
                    
                    const response = await fetch('${apiUrlBase}/batch_delete', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ urlsToDelete })
                    });
                    if (response.status === 401) { updateStatus('会话过期，请重新登录。', 'error'); return; }

                    const data = await response.json();
                    if (data.success) {
                        updateStatus(data.message, 'success');
                        fetchLinks(); // 重新加载数据
                    } else {
                        updateStatus('删除失败: ' + data.message, 'error');
                    }
                }

                // --- 数据交互函数 ---

                async function fetchLinks() {
                    updateStatus('正在加载数据...', 'info');
                    const response = await fetch('${apiUrlBase}/list');
                    
                    if (response.status === 401) { updateStatus('会话过期，请重新登录。', 'error'); return; }
                    
                    const data = await response.json();
                    if (data.success) {
                        fullLinkList = data.links;
                        hitCountSpan.textContent = data.totalHits.toLocaleString();
                        updateTagSelector(fullLinkList);
                        renderLinks(fullLinkList, currentPage); // 刷新列表并停留在当前页
                        updateStatus(\`已加载 \${fullLinkList.length} 条记录。\`, 'success');
                    } else {
                        updateStatus('加载失败: ' + data.message, 'error');
                    }
                }

                function fetchImageDimensions(url) {
                    return new Promise((resolve) => {
                        if (!url || !url.startsWith('http')) {
                            resolve({ width: 0, height: 0 });
                            return;
                        }
                        const img = new Image();
                        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
                        img.onerror = () => resolve({ width: 0, height: 0 }); 
                        img.crossOrigin = 'anonymous'; 
                        img.src = url;
                        setTimeout(() => resolve({ width: 0, height: 0 }), 3000); 
                    });
                }

                // V12 核心：追加链接功能
                async function appendLinks() {
                    updateStatus('正在处理并追加链接... (尝试自动获取分辨率)', 'info');
                    
                    const lines = textarea.value.split('\\n').map(l => l.trim()).filter(l => l.length > 0);
                    let newLinksData = lines.map(line => {
                        const parts = line.split('|').map(p => p.trim());
                        return {
                            url: parts[0],
                            tag: parts.length > 1 ? parts[1] : '${DEFAULT_TAG}'
                        };
                    });
                    
                    const validLinks = newLinksData.filter(item => item.url.startsWith('http'));
                    
                    const dimensionPromises = validLinks.map(async item => {
                        const { width, height } = await fetchImageDimensions(item.url);
                        return { 
                            ...item, 
                            width, 
                            height 
                        };
                    });

                    const finalDataForUpload = await Promise.all(dimensionPromises);
                    
                    const response = await fetch('${apiUrlBase}/append', { // 调用新的 APPEND 路由
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(finalDataForUpload) 
                    });
                    
                    if (response.status === 401) { updateStatus('会话过期，请重新登录。', 'error'); return; }

                    const data = await response.json();
                    if (data.success) {
                        updateStatus(data.message, 'success');
                        textarea.value = ''; // 成功后清空输入框
                        fetchLinks(); 
                    } else {
                        updateStatus('追加失败: ' + data.message, 'error');
                    }
                }
                
                async function runMaintenance() {
                    if (!confirm("警告：运行维护将移除所有无法访问的链接。确定继续吗？")) return;
                    updateStatus('正在运行维护检查...', 'info');
                    
                    const response = await fetch('${apiUrlBase}/maintenance', { method: 'POST' });
                    if (response.status === 401) { updateStatus('会话过期，请重新登录。', 'error'); return; }

                    const data = await response.json();
                    if (data.success) {
                        updateStatus(data.message, 'success');
                        fetchLinks(); 
                    } else {
                        updateStatus('维护失败: ' + data.message, 'error');
                    }
                }

                function logout() {
                    document.cookie = '${clearSessionCookie()}', 'session_token=deleted; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
                    window.location.reload(); 
                }

                // --- 导入/导出逻辑 ---

                function exportLinks() {
                    window.open('${apiUrlBase}/export', '_blank');
                    updateStatus('已请求导出文件，请检查您的下载。', 'info');
                }
                
                async function importLinks() {
                    let contentToParse = importedFileContent || importTextarea.value;
                    if (!contentToParse) {
                        updateStatus('请粘贴 JSON 内容或选择文件。', 'error');
                        return;
                    }
                    
                    try {
                        const importedArray = JSON.parse(contentToParse);
                        if (!Array.isArray(importedArray) || importedArray.length === 0) {
                             updateStatus('导入失败：文件内容不是有效的 JSON 数组或数组为空。', 'error');
                             return;
                        }
                        
                        const isValidFormat = importedArray.every(item => item && item.url);
                        if (!isValidFormat) {
                            updateStatus('导入失败：JSON 数组结构不正确，每个元素必须包含 "url" 字段。', 'error');
                            return;
                        }
                        
                        // 警告：导入将覆盖现有数据
                        if (!confirm(\`警告：即将导入 \${importedArray.length} 条数据，这将完全覆盖现有 \${fullLinkList.length} 条数据。确定覆盖吗？\`)) return;

                        updateStatus(\`正在导入 \${importedArray.length} 条数据并覆盖现有列表...\`, 'info');
                        
                        const response = await fetch('${apiUrlBase}/upload', { // 调用 UPLOAD 路由进行覆盖
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(importedArray) 
                        });
                        
                        const data = await response.json();
                        if (data.success) {
                            updateStatus(data.message, 'success');
                            importedFileContent = null;
                            importTextarea.value = '';
                            fetchLinks(); 
                        } else {
                            updateStatus('导入失败: ' + data.message, 'error');
                        }

                    } catch (e) {
                        updateStatus('JSON 解析错误。请确保文件内容是有效的 JSON 格式。', 'error');
                        console.error(e);
                    }
                }
                
                // 文件选择/拖拽事件监听
                jsonFileInput.addEventListener('change', (event) => {
                    const file = event.target.files[0];
                    if (file) {
                        const reader = new FileReader();
                        reader.onload = (e) => {
                            importedFileContent = e.target.result;
                            importTextarea.value = \`已加载文件: \${file.name} (\${importedFileContent.length} 字节)\`;
                            dropArea.textContent = \`文件已加载: \${file.name}\`;
                            updateStatus(\`文件 \${file.name} 已成功加载，点击下方按钮开始导入。\`, 'info');
                        };
                        reader.readAsText(file);
                    }
                });

                ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                    dropArea.addEventListener(eventName, (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }, false);
                });

                ['dragenter', 'dragover'].forEach(eventName => {
                    dropArea.addEventListener(eventName, () => dropArea.classList.add('dragover'), false);
                });

                ['dragleave', 'drop'].forEach(eventName => {
                    dropArea.addEventListener(eventName, () => dropArea.classList.remove('dragover'), false);
                });

                dropArea.addEventListener('drop', (e) => {
                    const dt = e.dataTransfer;
                    const files = dt.files;
                    if (files.length > 0 && files[0].name.endsWith('.json')) {
                        jsonFileInput.files = files; 
                        jsonFileInput.dispatchEvent(new Event('change'));
                    } else {
                        updateStatus('请拖入有效的 .json 文件。', 'error');
                    }
                }, false);
                
                fetchLinks(); 
            </script>
        `;
    } else {
        // --- 登录表单 ---
        content = `
            <h2>管理员登录</h2>
            <p>请输入您的管理员凭证以访问管理面板。</p>
            <input type="text" id="username" placeholder="用户名">
            <input type="password" id="password" placeholder="密码">
            <button onclick="login()">登录</button>
            <div id="loginMessage" class="status-msg"></div>
            <script>
                const loginMessage = document.getElementById('loginMessage');
                async function login() {
                    loginMessage.textContent = '正在认证...';
                    loginMessage.className = 'status-msg status-info';
                    const username = document.getElementById('username').value;
                    const password = document.getElementById('password').value;
                    
                    const response = await fetch('${apiUrlBase}/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password })
                    });

                    const data = await response.json();
                    if (data.success) {
                        loginMessage.textContent = '认证成功！正在进入...';
                        loginMessage.className = 'status-msg status-success';
                        setTimeout(() => window.location.reload(), 500);
                    } else {
                        loginMessage.textContent = '认证失败: ' + data.message;
                        loginMessage.className = 'status-msg status-error';
                    }
                }
            </script>
        `;
    }

    // 完整的 HTML 模板
    return new Response(`<!DOCTYPE html>
<html>
<head>
    <title>${PROJECT_NAME} - 管理终端</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>${MINIMAL_STYLE}</style>
</head>
<body>
    <div class="container">
        <h1>${PROJECT_NAME}</h1>
        ${content}
    </div>
</body>
</html>`, { 
        headers: { 'Content-Type': 'text/html; charset=utf-8' } 
    });
}


// --- 辅助前端页面 (无省略) ---

async function handleDocs(request, env) {
    const baseUrl = new URL(request.url).origin;
    const workerApiUrl = baseUrl + PATH_API_BASE;
    const workerAdminUrl = baseUrl + PATH_ADMIN;

    const listJson = await env.IMAGE_LINKS.get(KEY_IMAGE_LIST);
    const allLinks = listJson ? JSON.parse(listJson) : [];
    
    const tagCounts = allLinks.reduce((acc, item) => {
        const tag = item.tag || DEFAULT_TAG;
        acc[tag] = (acc[tag] || 0) + 1;
        return acc;
    }, {});

    let tagHtml = '';
    if (Object.keys(tagCounts).length > 0) {
        tagHtml = `
            <h3>当前可用标签 (${Object.keys(tagCounts).length} 个)</h3>
            <ul class="tag-list" style="list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 10px;">
                ${Object.entries(tagCounts).map(([tag, count]) => `
                    <li style="display: inline-block;">
                        <a href="${workerApiUrl}?tag=${tag}" target="_blank" class="tag-item" style="display: block;">
                            ${tag} <strong>(${count})</strong>
                        </a>
                    </li>
                `).join('')}
            </ul>
        `;
    } else {
        tagHtml = `<p>当前数据库中没有图片链接，请管理员前往配置。</p>`;
    }


    return new Response(`<!DOCTYPE html>
<html>
<head>
    <title>${PROJECT_NAME} - API 文档</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${MINIMAL_STYLE}
        .container { max-width: 900px; }
        .code-block { background-color: #f0f0f5; padding: 15px; border-radius: 8px; overflow-x: auto; margin: 20px 0; border: 1px solid #e0e0e0; }
        .code-block code { background: none; padding: 0; color: var(--color-text); }
        h3 { border-bottom: 1px solid #eee; padding-bottom: 5px; margin-bottom: 15px; margin-top: 30px;}
        a { color: var(--color-primary); text-decoration: none; transition: color var(--transition-base); }
        a:hover { color: #004d9c; }
    </style>
</head>
<body>
    <div class="container">
        <h1>API 参考文档</h1>
        <p>本项目提供了一个极简、高性能的随机图片分发服务。</p>
        
        <h2>🚀 核心 API 接口: <code>${workerApiUrl}</code></h2>
        
        <h3>1. 重定向获取 (GET /api)</h3>
        <p><strong>URL:</strong> <code>${workerApiUrl}</code></p>
        <p>返回 HTTP 302 重定向到随机图片的 URL。支持 <code>?tag=xxx</code> 和 <code>?ratio=W:H</code> 参数。</p>
        <p><strong>注意：</strong> 此接口的 302 响应头中会携带 <code>X-Image-Tag</code> 和 <code>X-Image-Dimensions</code> 信息。</p>

        <h3>2. JSON 元数据获取 (GET /api/info)</h3>
        <p><strong>URL:</strong> <code>${workerApiUrl}/info</code></p>
        <p>返回包含 URL、标签、尺寸等信息的 JSON 对象，不重定向。支持 <code>?tag=xxx</code> 和 <code>?ratio=W:H</code> 参数。</p>

        ${tagHtml}

        <p style="margin-top: 30px;">前往 <a href="${workerAdminUrl}">管理终端</a> 维护链接列表。</p>
    </div>
</body>
</html>`, { 
        headers: { 'Content-Type': 'text/html; charset=utf-8' } 
    });
}
async function handleTagsList(request, env) {
    const baseUrl = new URL(request.url).origin;
    const workerApiUrl = baseUrl + PATH_API_BASE;

    const listJson = await env.IMAGE_LINKS.get(KEY_IMAGE_LIST);
    const allLinks = listJson ? JSON.parse(listJson) : [];
    
    const tagCounts = allLinks.reduce((acc, item) => {
        const tag = item.tag || DEFAULT_TAG;
        acc[tag] = (acc[tag] || 0) + 1;
        return acc;
    }, {});
    
    const sortedTags = Object.entries(tagCounts).sort(([, a], [, b]) => b - a);
    
    let tagListHtml = '';
    if (sortedTags.length > 0) {
        tagListHtml = `
            <ul class="tag-list" style="margin-top: 30px; list-style: none; padding: 0; max-width: 600px;">
                ${sortedTags.map(([tag, count]) => `
                    <li style="display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px dashed #e3e3e3;">
                        <span>
                            <a href="${workerApiUrl}?tag=${tag}" target="_blank">
                                <strong>#${tag}</strong>
                            </a>
                        </span>
                        <span>${count} 张图片</span>
                    </li>
                `).join('')}
            </ul>
        `;
    } else {
        tagListHtml = `<p>数据库中尚无图片标签数据。</p>`;
    }


    return new Response(`<!DOCTYPE html>
<html>
<head>
    <title>${PROJECT_NAME} - 所有标签</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${MINIMAL_STYLE}
        .container { max-width: 700px; text-align: left; }
        .tag-list { list-style: none; padding: 0; }
        .tag-list a { text-decoration: none; color: var(--color-primary); }
    </style>
</head>
<body>
    <div class="container">
        <h1>所有图片标签概览</h1>
        <p>您可以在 API 中使用这些标签进行精确筛选。</p>
        ${tagListHtml}
        <p style="margin-top: 50px;">
            <a href="${baseUrl}">返回主页</a>
        </p>
    </div>
</body>
</html>`, { 
        headers: { 'Content-Type': 'text/html; charset=utf-8' } 
    });
}
function handleNoImage(request) {
    const baseUrl = new URL(request.url).origin;
    return new Response(`<!DOCTYPE html>
<html>
<head>
    <title>${PROJECT_NAME} - 无图片</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${MINIMAL_STYLE}
        body { background-color: var(--color-surface); }
        .container { 
            box-shadow: none; 
            border: none; 
            max-width: 600px;
            text-align: center;
            padding: 20vh 30px;
            background-color: transparent;
            min-height: auto;
        }
        h1 { font-size: 3em; color: var(--color-error); border-bottom: none; }
    </style>
</head>
<body>
    <div class="container">
        <h1>⚠️ 当前无图片</h1>
        <p class="hero-text">API 数据库中暂无可用链接。</p>
        <p>可能原因：</p>
        <ul>
            <li>网站管理员正在导入新的图片列表。</li>
            <li>所有链接都已失效，并被自动维护系统移除。</li>
        </ul>
        <p style="margin-top: 30px;">
            <a href="${baseUrl}">返回主页</a> | 
            <a href="${baseUrl + PATH_ADMIN}">管理员登录</a>
        </p>
    </div>
</body>
</html>`, { 
        status: 404,
        headers: { 'Content-Type': 'text/html; charset=utf-8' } 
    });
}
async function handleRoot(request, env) {
    const baseUrl = new URL(request.url).origin;
    const workerApiUrl = baseUrl + PATH_API_BASE;
    const workerAdminUrl = baseUrl + PATH_ADMIN;
    const workerDocsUrl = baseUrl + PATH_DOCS;

    const totalHits = parseInt(await env.IMAGE_LINKS.get(KEY_API_HITS) || 0);

    return new Response(`<!DOCTYPE html>
<html>
<head>
    <title>${PROJECT_NAME}</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
        ${MINIMAL_STYLE}
        body { background-color: var(--color-surface); }
        .container { 
            box-shadow: none; 
            border: none; 
            max-width: 800px;
            text-align: center;
            padding: 10vh 30px;
            background-color: transparent;
            min-height: auto;
        }
        h1 { 
            font-size: 4em; 
            font-weight: 700;
            border-bottom: none;
            padding-bottom: 0;
            margin-bottom: 20px;
            letter-spacing: -1px;
        }
        .hero-text { font-size: 1.5em; max-width: 600px; margin: 0 auto 40px; }
        .cta-links a { 
            margin: 0 10px; 
            padding: 10px 25px; 
            border-radius: 999px; 
            font-weight: 500;
            transition: background-color var(--transition-base), box-shadow var(--transition-base);
        }
        .cta-primary { background-color: var(--color-primary); color: var(--color-surface); }
        .cta-primary:hover { background-color: #0077ff; box-shadow: 0 4px 10px rgba(0, 113, 227, 0.3); }
        .cta-secondary { background-color: #f0f0f5; color: var(--color-text); }
        .cta-secondary:hover { background-color: #dcdcdc; }
        
        #preview-box {
            height: 300px; width: 100%; max-width: 600px; margin: 40px auto 0;
            background-color: #e9e9ed; border-radius: 12px;
            overflow: hidden;
            background-size: cover; background-position: center;
            box-shadow: var(--shadow-mid);
            transition: opacity 1s ease-in-out;
            opacity: 0;
        }
        .loaded-preview { opacity: 1 !important; }
        .stats-footer { margin-top: 15px; font-size: 0.9em; color: var(--color-secondary-text); }
        .stats-footer strong { color: var(--color-primary); }
    </style>
</head>
<body>
    <div class="header">
        <span>${PROJECT_NAME}</span>
        <a href="${workerAdminUrl}">管理员登录</a>
    </div>

    <div class="container">
        <h1>${PROJECT_NAME}</h1>
        <p class="hero-text">高性能、极简主义的随机图片分发服务，基于 Cloudflare Worker 驱动。</p>
        
        <p style="margin-bottom: 5px; color: var(--color-secondary-text); font-weight: 500;">API 链接 (点击可直接跳转):</p>
        <div class="api-link-box">
            <a href="${workerApiUrl}" target="_blank" style="text-decoration: none; flex-grow: 1;">
                <code id="apiUrlCode">${workerApiUrl}</code>
            </a>
            <button class="copy-btn cta-primary" onclick="copyApiUrl()">复制</button>
        </div>
        
        <div class="cta-links" style="margin-top: 20px;">
            <button class="cta-primary" onclick="copyApiUrl()">随机图片 API (copy)</button> 
            <a href="${workerDocsUrl}" class="cta-secondary">查看 API 文档</a>
            <a href="${baseUrl + PATH_TAGS_LIST}" class="cta-secondary" style="margin-top: 10px;">所有标签</a>
        </div>
        
        <div id="preview-box"></div>
        <p class="stats-footer">API 已被调用 <strong>${totalHits.toLocaleString()}</strong> 次。</p>
    </div>

    <script>
        const workerApiUrl = '${workerApiUrl}'; 
        const previewBox = document.getElementById('preview-box');
        
        function copyApiUrl() {
            const urlElement = document.getElementById('apiUrlCode');
            const urlText = urlElement.textContent;
            
            navigator.clipboard.writeText(urlText).then(() => {
                const originalText = document.querySelector('.cta-primary').textContent;
                document.querySelector('.cta-primary').textContent = '✅ 已复制!';
                setTimeout(() => {
                    document.querySelector('.cta-primary').textContent = originalText;
                }, 1500);
            }).catch(err => {
                console.error('无法复制文本:', err);
                alert('复制失败，请手动复制：' + urlText);
            });
        }

        fetch(workerApiUrl)
            .then(response => {
                const finalImageUrl = response.url;
                if (response.status === 302) {
                    const img = new Image();
                    img.onload = () => {
                        previewBox.style.backgroundImage = \`url('\${finalImageUrl}')\`;
                        previewBox.classList.add('loaded-preview');
                    };
                    img.onerror = () => {
                         previewBox.style.backgroundColor = '#dcdcdc';
                         previewBox.classList.add('loaded-preview');
                    };
                    img.crossOrigin = 'anonymous'; 
                    img.src = finalImageUrl;
                }
            })
            .catch(error => {
                console.error('Failed to load background image:', error);
            });
    </script>
</body>
</html>`, { 
        headers: { 'Content-Type': 'text/html; charset=utf-8' } 
    });
}


// --- MAIN ROUTER (V13：新增 scheduled handler) ---

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        if (path === '/' && method === 'GET') {
            return handleRoot(request, env);
        }
        if (path === PATH_DOCS && method === 'GET') {
            return handleDocs(request, env); 
        }
        if (path === PATH_TAGS_LIST && method === 'GET') {
            return handleTagsList(request, env);
        }
        if (path === PATH_NO_IMAGE && method === 'GET') {
            return handleNoImage(request);
        }
        
        if (path.startsWith(PATH_API_BASE)) {
            const apiPath = path.substring(PATH_API_BASE.length);
            
            if (apiPath === '' && method === 'GET') { 
                return handleRandomRedirect(request, env);
            }
            if (apiPath === '/info' && method === 'GET') { 
                return handleImageInfo(request, env);
            }
            if (apiPath === '/login' && method === 'POST') {
                return handleLogin(request, env);
            }
            if (apiPath === '/upload' && method === 'POST') { // 覆盖现有列表 (导入功能)
                return handleImageUpdate(request, env);
            }
            if (apiPath === '/append' && method === 'POST') { // V12 新增：追加链接
                return handleImageAppend(request, env);
            }
            if (apiPath === '/batch_delete' && method === 'POST') { // V12 新增：批量删除
                return handleImageBatchDelete(request, env);
            }
            if (apiPath === '/list' && method === 'GET') {
                return handleImageList(request, env);
            }
            if (apiPath === '/maintenance' && method === 'POST') { 
                 return handleMaintenance(request, env); // HTTP 触发时调用
            }
            if (apiPath === '/export' && method === 'GET') { 
                return handleImageExport(request, env);
            }
        }

        if (path === PATH_ADMIN && method === 'GET') {
            return handleAdminPanel(request, env);
        }

        return new Response("404 Not Found", { status: 404 });
    },
    
    /**
     * V13 新增：定时器触发的维护函数
     * @param {ScheduledEvent} event 
     * @param {Env} env 
     * @param {ExecutionContext} ctx 
     */
    async scheduled(event, env, ctx) {
        // 定时器触发时，调用 handleMaintenance 核心逻辑
        // 传入 null 代替 request，让函数知道这是定时器触发，无需身份验证
        const resultPromise = handleMaintenance(null, env); 
        
        // 使用 ctx.waitUntil 确保维护任务在 Worker 结束前完成
        ctx.waitUntil(resultPromise); 
    }
};
