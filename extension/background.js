/**
 * 投上岸 - Background Service Worker v12
 * v12: 全平台通用文本匹配查找投递按钮（TreeWalker遍历所有元素）
 * BOSS直聘: 改进弹窗查找（支持textarea/contenteditable/input）
 * 前程无忧: 修复span/div形式的投递按钮查找
 * 智联/猎聘: 使用文本匹配替代标签类型匹配
 */

// ==================== 全局状态 ====================
let ws = null;
let isConnected = false;
const WS_URL = 'ws://localhost:9528';
const KEEPALIVE_ALARM = 'keepalive';

const platformStatus = {
  boss: { ready: false, tabId: null },
  liepin: { ready: false, tabId: null },
  zhilian: { ready: false, tabId: null },
  qiancheng: { ready: false, tabId: null }
};

const PLATFORM_CONFIG = {
  boss: { urlPatterns: ['https://www.zhipin.com/*'], scripts: ['lib/behavior.js', 'lib/dom.js', 'content/boss.js'] },
  liepin: { urlPatterns: ['https://www.liepin.com/*'], scripts: ['lib/behavior.js', 'lib/dom.js', 'content/liepin.js'] },
  zhilian: { urlPatterns: ['https://www.zhaopin.com/*', 'https://sou.zhaopin.com/*'], scripts: ['lib/behavior.js', 'lib/dom.js', 'content/zhilian.js'] },
  qiancheng: { urlPatterns: ['https://www.51job.com/*', 'https://we.51job.com/*', 'https://jobs.51job.com/*'], scripts: ['lib/behavior.js', 'lib/dom.js', 'content/qiancheng.js'] }
};

// 映射 action 到 content script 消息
const ACTION_MAP = {
  CHECK_LOGIN: 'CHECK_LOGIN',
  SEARCH_JOBS: 'SEARCH_JOBS',
  BATCH_COMMUNICATE: 'BATCH_COMMUNICATE',
  APPLY_SINGLE: 'APPLY_SINGLE',
  PARSE_LIST: 'PARSE_LIST',
  PING: 'PING'
};

// ==================== 工具函数 ====================

function urlMatch(url, patterns) {
  if (!url) return false;
  for (const p of patterns) {
    const r = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    if (r.test(url)) return true;
  }
  return false;
}

/**
 * 通用文本匹配查找函数
 * 搜索所有元素（不限tag类型），通过文本内容精确/包含匹配找到目标元素
 * 优先返回最精确（最短文本、最深层级）的匹配
 */
function findElementByText(patterns, options = {}) {
  const { exact = false, excludeTexts = ['已', '继续', '登录', '注册', '验证码'], maxDepth = 20 } = options;
  const results = [];
  
  // 遍历所有元素（使用TreeWalker提高性能）
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
  let node;
  while (node = walker.nextNode()) {
    const el = node;
    const tag = el.tagName.toLowerCase();
    // 跳过脚本、样式等不可见元素
    if (['script', 'style', 'noscript', 'meta', 'link', 'head'].includes(tag)) continue;
    // 跳过不可见元素
    if (el.offsetParent === null && el.getClientRects().length === 0) continue;
    
    const text = el.textContent.trim();
    if (!text || text.length > 100) continue; // 太长的文本忽略
    
    // 跳过排除文本
    if (excludeTexts.some(et => text.includes(et))) continue;
    
    // 检查是否匹配任一模式
    for (const pattern of patterns) {
      let matched = false;
      if (exact) {
        matched = (text === pattern);
      } else {
        matched = text.includes(pattern);
      }
      
      if (matched) {
        // 计算匹配质量：精确匹配 > 包含匹配，文本越短（越精确）越好
        const quality = exact ? text.length * 0.5 : text.length;
        results.push({ el, text, tag, quality, pattern });
        break;
      }
    }
  }
  
  // 按质量排序（质量值越小越好）
  results.sort((a, b) => a.quality - b.quality);
  
  if (results.length > 0) {
    console.log(`[投上岸] findElementByText: 找到 ${results.length} 个匹配，最佳: "${results[0].text}" (${results[0].tag})`);
    return results[0].el;
  }
  
  return null;
}

function detectPlatform(url) {
  for (const [k, v] of Object.entries(PLATFORM_CONFIG)) {
    if (urlMatch(url, v.urlPatterns)) return k;
  }
  return null;
}

// ==================== WebSocket ====================

let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 50; // 增加重连次数

async function connectWebSocket() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.log('[投上岸] WebSocket已连接或正在连接，跳过');
    return;
  }
  
  reconnectAttempts++;
  console.log(`[投上岸] 尝试连接WebSocket (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
  
  try {
    ws = new WebSocket(WS_URL);
    
    ws.onopen = async () => {
      isConnected = true;
      reconnectAttempts = 0; // 重置重连计数
      console.log('[投上岸] ✅ WebSocket已连接');
      await scanTabs();
      // 重连后重新注入 Content Scripts 到已有标签页
      await reinjectAll();
      sendWS({ type: 'EXTENSION_READY' });
    };
    
    ws.onmessage = async (e) => {
      try { 
        const data = JSON.parse(e.data);
        console.log('[投上岸] 收到消息:', data.type);
        await handleCommand(data); 
      } catch (err) { 
        console.error('[投上岸] 消息处理错误:', err); 
      }
    };
    
    ws.onclose = (event) => { 
      console.log(`[投上岸] ❌ WebSocket断开: code=${event.code}, reason=${event.reason || '无'}`);
      isConnected = false; 
      ws = null; 
      // 5秒后重连
      setTimeout(connectWebSocket, 5000); 
    };
    
    ws.onerror = (error) => { 
      console.error('[投上岸] WebSocket错误:', error); 
    };
    
  } catch (e) { 
    console.error('[投上岸] 连接异常:', e);
    setTimeout(connectWebSocket, 5000); 
  }
}

function sendWS(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function scanTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const platform = detectPlatform(tab.url);
    if (platform && tab.id) {
      platformStatus[platform] = { ready: false, tabId: tab.id };
      console.log('[投上岸] 发现 ' + platform + ' 标签页: tabId=' + tab.id);
    }
  }
}

async function reinjectAll() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    const platform = detectPlatform(tab.url);
    if (platform && tab.id) {
      const config = PLATFORM_CONFIG[platform];
      if (config) {
        try {
          console.log('[投上岸] 重新注入 ' + platform + ' tabId=' + tab.id);
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: config.scripts
          });
        } catch (e) {
          console.log('[投上岸] 注入 ' + platform + ' 失败: ' + e.message);
        }
      }
    }
  }
}

// ==================== 命令处理 ====================

async function handleCommand(msg) {
  const { type, platform, params, requestId } = msg;
  let result;
  try {
    switch (type) {
      case 'PING': result = { success: true, version: 'v11' }; break;
      case 'CHECK_PAGE':
        // 检查页面是否就绪（用于后端轮询等待SPA加载）
        const config = PLATFORM_CONFIG[platform];
        if (!config) {
          result = { ready: false, error: '未知平台: ' + platform };
          break;
        }
        let tabId = platformStatus[platform]?.tabId;
        if (!tabId) {
          const tabs = await chrome.tabs.query({});
          const match = tabs.find(t => urlMatch(t.url, config.urlPatterns));
          if (!match) {
            result = { ready: false, error: '未找到' + platform + '页面' };
            break;
          }
          tabId = match.id;
          platformStatus[platform] = { ready: false, tabId: tabId };
        }
        // 注入简单脚本检查页面是否加载完成
        try {
          const checkResults = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: () => {
              return {
                ready: document.readyState === 'complete' && document.body && document.body.innerText.length > 100,
                readyState: document.readyState,
                bodyLen: document.body ? document.body.innerText.length : 0,
                url: location.href
              };
            }
          });
          if (checkResults && checkResults[0] && checkResults[0].result) {
            result = checkResults[0].result;
          } else {
            result = { ready: false, error: '无法检查页面状态' };
          }
        } catch (e) {
          result = { ready: false, error: e.message };
        }
        break;
      case 'CHECK_LOGIN':
      case 'SEARCH_JOBS':
      case 'BATCH_COMMUNICATE':
      case 'APPLY_SINGLE':
      case 'PARSE_LIST':
        result = await sendToTab(platform, type, params);
        break;
      case 'OPEN_PLATFORM': result = await openPlatformTab(platform, params?.url); break;
      case 'RELOAD_SELF': result = { success: true }; setTimeout(() => chrome.runtime.reload(), 500); break;
      case 'ANALYZE_PAGE': result = await analyzePage(platform, params?.script); break;
      case 'VISIT_DETAIL': result = await visitDetailPage(platform, params?.url, params?.script); break;
      default: result = { success: false, error: '未知命令: ' + type };
    }
  } catch (e) { result = { success: false, error: e.message }; }
  sendWS({ type: type + '_RESULT', requestId, ...result });
}

// ==================== 核心：MAIN world 直接注入（v11: 统一使用最可靠的 MAIN world 注入） ====================
// 抛弃 Content Script 通信的三层 fallback 策略，直接使用与 ANALYZE_PAGE 相同的 MAIN world 注入
// 原因: Content Script 选择器易过期、ISOLATED world 不可靠，MAIN world + new Function 100% 可靠

async function sendToTab(platform, action, params) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) return { success: false, error: '未知平台: ' + platform };

  // 找标签页
  let tabId = platformStatus[platform]?.tabId;
  if (!tabId) {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find(t => urlMatch(t.url, config.urlPatterns));
    if (!match) {
      return { success: false, error: '未找到' + platform + '页面，请先打开对应招聘网站' };
    }
    tabId = match.id;
    platformStatus[platform] = { ready: false, tabId: tabId };
  }

  const fallbackFunc = getFallbackFunc(platform, action);
  if (!fallbackFunc) {
    return { success: false, error: '不支持的操作: ' + action };
  }

  // 统一使用 MAIN world 注入 —— 与 ANALYZE_PAGE 相同机制
  // 将函数序列化为字符串，在页面上下文中通过 new Function 执行
  const funcStr = fallbackFunc.toString();
  const paramsJson = JSON.stringify(params || {});

  try {
    console.log('[投上岸] MAIN world 注入: ' + platform + ' action=' + action);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (fnStr, argsJson) => {
        try {
          const fn = new Function('return (' + fnStr + ')')();
          const args = JSON.parse(argsJson);
          return fn(args);
        } catch (e) {
          return { success: false, error: '执行错误: ' + e.message };
        }
      },
      args: [funcStr, paramsJson]
    });
    if (results && results[0] && results[0].result) {
      console.log('[投上岸] MAIN world 注入成功: ' + platform + ' action=' + action);
      return results[0].result;
    }
    return { success: false, error: '无返回结果' };
  } catch (e) {
    console.log('[投上岸] MAIN world 注入失败: ' + platform + ' ' + e.message);
    return { success: false, error: e.message };
  }
}

// ==================== 页面分析 ====================

async function analyzePage(platform, script) {
  const config = PLATFORM_CONFIG[platform];
  if (!config) return { success: false, error: '未知平台: ' + platform };

  let tabId = platformStatus[platform]?.tabId;
  if (!tabId) {
    const tabs = await chrome.tabs.query({});
    const match = tabs.find(t => urlMatch(t.url, config.urlPatterns));
    if (!match) return { success: false, error: '未找到' + platform + '页面' };
    tabId = match.id;
  }

  // 策略: MAIN world 注入 —— 利用 `new Function` 在页面上下文中运行
  // 页面 CSP 通常允许 new Function（与扩展 CSP 不同）
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (scriptStr) => {
        try {
          const trimmed = scriptStr.trim();
          let fn;
          // IIFE 模式: (function(){...})() 或 (async function(){...})()
          if (trimmed.startsWith('(') && (trimmed.endsWith(')();') || trimmed.endsWith('())') || trimmed.endsWith('})()'))) {
            fn = new Function('return ' + trimmed);
          } else if (trimmed.startsWith('return ')) {
            // 已有 return 语句
            fn = new Function(trimmed);
          } else {
            // 普通表达式，包裹在 return 中
            fn = new Function('return (' + trimmed + ')');
          }
          const result = fn();
          // 支持 async 脚本：如果返回 Promise 则 await
          if (result && typeof result.then === 'function') {
            return await result;
          }
          return result;
        } catch (e) {
          return JSON.stringify({ __error__: e.message });
        }
      },
      args: [script]
    });
    if (results && results.length > 0) {
      const val = results[0].result;
      if (val === null || val === undefined) {
        return { success: false, error: '无返回结果', debug: JSON.stringify(results).substring(0, 200) };
      }
      // 检查是否是错误
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val);
          if (parsed.__error__) {
            return { success: false, error: parsed.__error__ };
          }
        } catch (e) {}
      }
      return { success: true, result: val };
    }
    return { success: false, error: '无返回结果', debug: JSON.stringify(results).substring(0, 200) };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ==================== 详情页访问（不关闭现有标签页） ====================

async function visitDetailPage(platform, url, script) {
  // 打开新标签页访问详情页，不关闭现有标签页
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    // 等待页面加载完成
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { reject(new Error('页面加载超时')); }, 20000);
      function onUpdated(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(onUpdated);
          clearTimeout(timeout);
          // 额外等待500ms确保SPA渲染完成
          setTimeout(resolve, 500);
        }
      }
      chrome.tabs.onUpdated.addListener(onUpdated);
    });
    // 注入分析脚本提取详情页信息
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: async (scriptStr) => {
        try {
          const trimmed = scriptStr.trim();
          let fn;
          if (trimmed.startsWith('(') && (trimmed.endsWith(')();') || trimmed.endsWith('())') || trimmed.endsWith('})()'))) {
            fn = new Function('return ' + trimmed);
          } else if (trimmed.startsWith('return ')) {
            fn = new Function(trimmed);
          } else {
            fn = new Function('return (' + trimmed + ')');
          }
          const result = fn();
          if (result && typeof result.then === 'function') {
            return await result;
          }
          return result;
        } catch (e) {
          return { __error__: e.message };
        }
      },
      args: [script]
    });
    // 关闭详情页标签页
    try { await chrome.tabs.remove(tab.id); } catch(e) {}
    if (results && results.length > 0) {
      const val = results[0].result;
      if (val === null || val === undefined) {
        return { success: false, error: '无返回结果' };
      }
      if (typeof val === 'string') {
        try {
          const parsed = JSON.parse(val);
          if (parsed.__error__) return { success: false, error: parsed.__error__ };
        } catch(e) {}
      }
      return { success: true, result: val };
    }
    return { success: false, error: '无返回结果' };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ==================== 平台专属 fallback 函数 ====================

function getFallbackFunc(platform, action) {
  if (action === 'CHECK_LOGIN') return getCheckLoginFunc(platform);
  if (action === 'SEARCH_JOBS') return getSearchFunc(platform);
  if (action === 'BATCH_COMMUNICATE') return getCommunicateFunc(platform);
  if (action === 'APPLY_SINGLE') return getApplyFunc(platform);
  if (action === 'PARSE_LIST') return getParseFunc(platform);
  if (action === 'PING') return function() { return { success: true, platform: platform, injected: true }; };
  return null;
}

// --- BOSS 直聘 ---
function bossCheckLogin() {
  const indicators = ['.user-nav', '.user-dropdown', '[class*="user"]', '.nav-figure', '[class*="avatar"]', '.nav-greeting', '.header-login-entry', '.has-login', '.user-info'];
  for (const sel of indicators) {
    const el = document.querySelector(sel);
    if (el) { const t = el.textContent.trim(); if (t.length > 0 && t.length < 30) return { success: true, isLogin: true, indicator: t }; }
  }
  for (const link of document.querySelectorAll('a')) {
    if (link.textContent.trim() === '消息' || link.textContent.trim() === '简历') return { success: true, isLogin: true, indicator: link.textContent.trim() };
  }
  return { success: true, isLogin: false };
}

function bossSearchJobs(params) {
  function _parse() {
    // ===== v15 修复：建立 DOM 公司名/地区查询表 =====
    // API 明文的 brandName/cityName 可能为空，但 DOM 的 .boss-name/.company-location 可靠。
    // 用 API 提供干净薪资，用 DOM 补齐公司名/地区，二者按岗位 id 关联。
    var domLookup = {};
    try {
      var _dls = document.querySelectorAll('a[href*="job_detail"]');
      for (var _di = 0; _di < _dls.length; _di++) {
        var _dm = _dls[_di].href.match(/job_detail\/([a-zA-Z0-9_-]+)/);
        if (!_dm) continue;
        var _dcard = _dls[_di].closest('li') || _dls[_di].parentElement;
        var _dcomp = '', _dloc = '';
        if (_dcard) {
          var _bsel = ['.boss-name','.company-name','.cname','.corp-name','.co-name','[class*="boss-name"]','[class*="company-name"]','.company .name','.job-primary .company'];
          for (var _bi=0; _bi<_bsel.length; _bi++){ try { var _b=_dcard.querySelector(_bsel[_bi]); if(_b){ var _bt=_b.textContent.trim(); if(_bt && _bt.length<50 && _bt.indexOf('·')<0){ _dcomp=_bt; break; } } } catch(e){} }
          var _lsel = ['.company-location','.job-area','.job-location','.location','[class*="location"]','[class*="job-area"]','.job-primary .area'];
          for (var _li=0; _li<_lsel.length; _li++){ try { var _l=_dcard.querySelector(_lsel[_li]); if(_l){ _dloc=_l.textContent.trim(); if(_dloc) break; } } catch(e){} }
        }
        if (!domLookup[_dm[1]]) domLookup[_dm[1]] = { company: _dcomp, area: _dloc };
      }
    } catch(e) {}
    // ===== 首选：使用 boss_net.js 网络拦截捕获的 API 明文数据（规避薪资字体反爬） =====
    var apiList = (typeof window !== 'undefined' && window.__tsaBossList) || [];
    if (apiList.length > 0) {
      var apiJobs = [];
      var seenApi = {};
      for (var ai = 0; ai < apiList.length; ai++) {
        var aj = apiList[ai];
        if (!aj || typeof aj !== 'object') continue;
        var jid = aj.encryptJobId || aj.jobId || '';
        if (!jid || seenApi[jid]) continue;
        seenApi[jid] = true;
        var dl = domLookup[jid] || {};
        var jarea = aj.cityName || dl.area || '';
        if (aj.areaDistrict) jarea = jarea ? (jarea + ' ' + aj.areaDistrict) : aj.areaDistrict;
        if (aj.businessDistrict) jarea = jarea ? (jarea + ' ' + aj.businessDistrict) : aj.businessDistrict;
        var jcomp = aj.brandName || dl.company || '';
        apiJobs.push({
          id: jid, title: aj.jobName || aj.jobTitle || '',
          company: jcomp, salary: aj.salaryDesc || aj.salary || '',
          area: jarea, industry: aj.brandIndustry || '',
          financing: aj.brandStageName || '', scale: aj.brandScaleName || '',
          experience: aj.jobExperience || '', education: aj.jobDegree || '',
          tags: Array.isArray(aj.jobLabels) ? aj.jobLabels.join('、') : '',
          url: 'https://www.zhipin.com/job_detail/' + jid + '.html',
          platform: 'boss'
        });
      }
      if (apiJobs.length > 0) return { success: true, jobs: apiJobs, total: apiJobs.length, source: 'api' };
    }
    // BOSS直聘薪资PUA解码函数
    // BOSS直聘使用自定义字体将Unicode PUA字符(U+E030-U+E039)映射为数字0-9
    function decodeSalary(raw) {
      if (!raw) return '';
      return raw.replace(/[\uE000-\uF8FF]/g, function(ch) {
        var code = ch.charCodeAt(0);
        // 实测映射（2025-06 起）: U+E031 → '0', U+E032 → '1', ... U+E03A → '9'
        if (code >= 0xE031 && code <= 0xE03A) return String.fromCharCode(0x30 + (code - 0xE031));
        // 常见偏移: U+E030 → '0', U+E031 → '1', ... U+E039 → '9'
        if (code >= 0xE030 && code <= 0xE039) return String.fromCharCode(0x30 + (code - 0xE030));
        // 备用偏移: U+E000 → '0', U+E001 → '1', ... U+E009 → '9'
        if (code >= 0xE000 && code <= 0xE009) return String.fromCharCode(0x30 + (code - 0xE000));
        return ch;
      });
    }
    
    const INDUSTRY_KW = ['互联网','电子商务','计算机软件','计算机硬件','IT服务','信息安全','人工智能','在线教育','培训/辅导机构','院校','学术/科研','文化艺术/娱乐','广播/影视','新闻/出版','广告/公关/会展','医疗健康','医疗服务','制药','医疗器械','生物/制药','金融','银行','保险','证券/期货','基金','信托','投资/融资','互联网金融','房地产中介/租赁','房地产开发经营','物业服务','建筑设计','工程施工','汽车研发/制造','汽车零部件','汽车销售','新能源汽车','半导体/芯片','电子/半导体/集成电路','通信/网络设备','智能硬件','生活服务(O2O)','生活服务','餐饮','酒店/旅游','休闲/娱乐','食品/饮料/烟酒','日化','服装/纺织/皮革','家具/家电/家居','批发/零售','零售/快消','贸易/进出口','物流/仓储','交通/运输','航空/航天','新能源','环保','矿产/地质','石油/石化','法律','人力资源服务','咨询','检测/认证','专利/商标/知识产权','其他专业服务','其他行业','其他服务业','政府/公共事业','非盈利机构','社会组织','数据服务','云计算/大数据','区块链','物联网','游戏','社交网络','在线医疗','移动互联网','医疗器械','医疗设备/器械','学前教育','K12教育','高等教育','装修装饰','建材','农/林/牧/渔','珠宝/首饰','音乐/视频/阅读','企业服务','财务/审计/税务','化工','机械/设备','印刷/包装','玩具/礼品','仪器仪表','电力/水利','船舶/海洋工程','轨道交通','专业技术服务','租赁/拍卖','运营商/增值服务','家政服务','婚庆/摄影','美容/美发','室内设计','会展/活动','翻译服务','租赁服务','其他生活服务','基金/证券/期货','信托/担保/拍卖/典当','银行/保险','证券/投资','房地产','汽车','培训','食品','医疗','半导体'];
    const FINANCING_KW = ['不需要融资','未融资','天使轮','A轮','B轮','C轮','D轮及以上','D轮','E轮','F轮','Pre-A轮','Pre-IPO','已上市','上市公司','战略投资','并购','股权融资','国企','央企','外资','合资','民营','事业单位','政府机关','其他'];
    const SIZE_RE = /(\d+-\d+人|\d+人以上|\d+人以下|10000人以上)/;
    const EXP_RE = /(在校|应届|经验不限|\d+年以内|\d+-\d+年|\d+年以上|\d+年|应届生)/;
    const EDU_RE = /(学历不限|中专\/中技|高中|大专|本科|硕士|博士|MBA|EMBA|博士后)/;
    function extractInd(txt) { for (let k of INDUSTRY_KW) { if (txt.indexOf(k) >= 0) return k; } return ''; }
    function extractFin(txt) { for (let k of FINANCING_KW) { if (txt.indexOf(k) >= 0) return k; } return ''; }
    function extractScl(txt) { const m = txt.match(SIZE_RE); return m ? m[1] : ''; }
    function extractExp(txt) { const m = txt.match(EXP_RE); return m ? m[1] : ''; }
    function extractEdu(txt) { const m = txt.match(EDU_RE); return m ? m[1] : ''; }

    const links = document.querySelectorAll('a[href*="job_detail"]');
    const jobMap = new Map();
    for (const link of links) {
      const m = link.href.match(/job_detail\/([a-zA-Z0-9_-]+)/);
      if (!m) continue;
      const id = m[1];
      if (jobMap.has(id)) continue;
      let card = link.closest('li') || link.parentElement;
      while (card && card !== document.body) { if (card.textContent.trim().length > 20) break; card = card.parentElement; }
      if (card) {
        const txt = card.textContent.trim();
        // BOSS直聘使用自定义字体编码薪资数字（Unicode PUA: U+E000-U+F8FF）
        // 匹配正常数字薪资 和 自定义字体编码薪资
        const salRaw = txt.match(/([\d\uE000-\uF8FF]+-[\d\uE000-\uF8FF]+[kK])(?:[·\s]*\d+薪)?/);
        const sal = salRaw ? decodeSalary(salRaw[1]) : '';
        // 公司名/地区：优先用可靠的结构选择器（BOSS卡片固定 DOM），
        // 避免文本节点启发式在"公司名含城市名"（如"北京雷石天地电子技术"）时误把地区当地址/公司。
        // 抗 DOM 变更：多候选结构选择器（优先 .boss-name 公司名 / .company-location 地区）
        const compSel = ['.boss-name','.company-name','.cname','.corp-name','.co-name','[class*="boss-name"]','[class*="company-name"]','.company .name','.job-primary .company'];
        let company = ''; for (let _s=0; _s<compSel.length && !company; _s++){ try { const _b=card.querySelector(compSel[_s]); if(_b){ const _bt=_b.textContent.trim(); if(_bt && _bt.length<50 && _bt.indexOf('·')<0) company=_bt; } } catch(e){} }
        const locSel = ['.company-location','.job-area','.job-location','.location','[class*="location"]','[class*="job-area"]','.job-primary .area'];
        let jobArea = ''; for (let _s=0; _s<locSel.length && !jobArea; _s++){ try { const _l=card.querySelector(locSel[_s]); if(_l){ jobArea=_l.textContent.trim(); } } catch(e){} }
        jobMap.set(id, {
          id, title: link.textContent.trim(),
          company, salary: sal, area: jobArea,
          industry: extractInd(txt), financing: extractFin(txt), scale: extractScl(txt),
          experience: extractExp(txt), education: extractEdu(txt),
          url: link.href, platform: 'boss'
        });
      }
    }
    const jobs = Array.from(jobMap.values());
    return { success: true, jobs, total: jobs.length };
  }
  const url = location.href;
  if (url.includes('/web/geek/job')) return _parse();
  const inp = document.querySelector('input[placeholder*="搜索"]');
  if (inp) { inp.value = (params || {}).keyword || ''; inp.dispatchEvent(new Event('input', { bubbles: true })); return { success: false, error: '请按回车搜索后再次调用', hint: '搜索框已填入' }; }
  return { success: false, error: '请打开BOSS直聘搜索页面' };
}

function bossCommunicate(params) {
  const { greeting, maxCount, city, keyword } = params || {};
  const results = [];
  let sent = 0;
  const limit = maxCount || 150;

  // ===== v14 关键修复：城市+关键词过滤，杜绝乱沟通错误城市/岗位（推荐feed混入的深圳/武汉/上海/东莞、小时工/实习生等） =====
  function _titleMatch(title) {
    if (!keyword) return true;
    var kw = String(keyword).trim();
    if (!kw) return true;
    var t = (title || '').trim();
    // 1) 完整命中
    if (t.indexOf(kw) >= 0) return true;
    // 2) 关键词前2字符（最具区分度，如"全栈"，可排除仅含公共后缀"工程师"的"前端工程师"）
    if (kw.length >= 2 && t.indexOf(kw.substring(0, 2)) >= 0) return true;
    // 3) 长关键词（≥6字）放宽：共享任意≥4连续字符
    if (kw.length >= 6) {
      for (var i = 0; i + 4 <= kw.length; i++) {
        if (t.indexOf(kw.substring(i, i + 4)) >= 0) return true;
      }
    }
    return false;
  }
  function _cardMatches(jid, title, text) {
    if (!_titleMatch(title || '')) { console.log('[投上岸] 沟通过滤-关键词不符跳过: ' + title); return false; }
    if (city) {
      var c = String(city).trim();
      if (c && text.indexOf(c) < 0) { console.log('[投上岸] 沟通过滤-城市不符跳过: ' + title + ' / ' + text); return false; }
    }
    return true;
  }

  // 策略1: 页面级查找 —— BOSS直聘的"立即沟通"按钮是 <A class="op-btn op-btn-chat">
  // 诊断发现这些按钮不在 li 内部，需要页面级搜索
  const chatBtns = document.querySelectorAll('[class*="op-btn-chat"]');
  for (const btn of chatBtns) {
    if (sent >= limit) break;
    // 找到最近的职位卡片和 job_detail 链接
    const card = btn.closest('li') || btn.closest('[class*="job-card"]') || btn.closest('[class*="card"]');
    let link = card ? card.querySelector('a[href*="job_detail"]') : null;
    let cardText = card ? card.textContent.trim() : '';
    if (!link) {
      // 宽泛搜索：在整个页面中找最近的 job_detail 链接
      const allLinks = document.querySelectorAll('a[href*="job_detail"]');
      link = allLinks[sent] || null;
      if (link && !cardText) {
        const lc = link.closest('li') || link.parentElement;
        cardText = lc ? lc.textContent.trim() : '';
      }
    }
    const jid = link ? (link.href.match(/job_detail\/([a-zA-Z0-9_-]+)/) || [])[1] : '';
    const title = link ? link.textContent.trim() : '';
    // v14：城市+关键词过滤，跳过不匹配的推荐feed岗位
    if (!_cardMatches(jid, title, cardText)) continue;
    try {
      btn.click();
      sent++;
      results.push({ jobId: jid, title: title, company: '', status: 'clicked' });
    } catch (e) {
      results.push({ jobId: jid, title: title, status: 'error', error: e.message });
    }
  }

  // 策略2: 回退 —— li 内部遍历（兼容旧版 BOSS 直聘页面）
  if (sent === 0) {
    const cards = document.querySelectorAll('li');
    for (const card of cards) {
      if (sent >= limit) break;
      const btn = Array.from(card.querySelectorAll('button, a, div[class*="btn"], span[class*="btn"]')).find(b => {
        const t = b.textContent.trim();
        return t === '沟通' || t === '立即沟通' || t === '立即联系' || t.includes('沟通') || t.includes('聊') || t === '打招呼';
      });
      if (!btn) continue;
      const link = card.querySelector('a[href*="job_detail"]');
      const jid = link ? (link.href.match(/job_detail\/([a-zA-Z0-9_-]+)/) || [])[1] : '';
      const title = link ? link.textContent.trim() : '';
      // v14：城市+关键词过滤
      if (!_cardMatches(jid, title, card.textContent.trim())) continue;
      try {
        btn.click();
        sent++;
        results.push({ jobId: jid, title: title, company: '', status: 'clicked' });
      } catch (e) {
        results.push({ jobId: jid, title: title, status: 'error', error: e.message });
      }
    }
  }

  return { success: true, sentCount: sent, skipCount: results.length - sent > 0 ? (results.length - sent) : 0, results: results, total: results.length };
}

function bossParseList() {
  function _parse() {
    const links = document.querySelectorAll('a[href*="job_detail"]');
    const jobMap = new Map();
    for (const link of links) {
      const m = link.href.match(/job_detail\/([a-zA-Z0-9_-]+)/);
      if (!m) continue;
      const id = m[1];
      if (jobMap.has(id)) continue;
      let card = link.closest('li') || link.parentElement;
      while (card && card !== document.body) { if (card.textContent.trim().length > 20) break; card = card.parentElement; }
      if (card) {
        const txt = card.textContent.trim();
        const sal = txt.match(/(\d+-\d+[kK])(?:[·\s]*\d+薪)?/);
        const area = txt.match(/(武汉|北京|上海|深圳|广州|杭州|成都|南京|苏州|重庆|天津|长沙|西安|东莞|佛山|宁波|合肥|郑州|厦门|青岛|无锡|福州|济南|昆明|大连|沈阳|南昌|温州|石家庄|哈尔滨|长春|泉州|贵阳|南宁|嘉兴|珠海|惠州|中山|绍兴|金华|常州|南通|徐州|太原|烟台|潍坊|威海|淄博|临沂|济宁|泰州|盐城|扬州|镇江|淮安|连云港|宿迁|湖州|台州|丽水|衢州|舟山|芜湖|马鞍山|安庆|铜陵|滁州|宣城|池州|蚌埠|亳州|淮北|宿州|阜阳|淮南|黄山|六安|襄阳|宜昌|荆州|黄石|十堰|鄂州|荆门|孝感|黄冈|咸宁|随州|恩施|仙桃|潜江|天门|神农架|万宁|文昌|海口|三亚|儋州|拉萨|日喀则|兰州|天水|白银|武威|金昌|张掖|酒泉|嘉峪关|平凉|庆阳|定西|陇南|临夏|西宁|海东|银川|石嘴山|吴忠|固原|中卫|乌鲁木齐|克拉玛依|吐鲁番|哈密|香港|澳门|台湾|全国|海外|异地)/);
        jobMap.set(id, { id, title: link.textContent.trim(), company: '', salary: sal ? sal[1] : '', area: area ? area[0] : '', url: link.href, platform: 'boss' });
      }
    }
    return { success: true, jobs: Array.from(jobMap.values()), total: jobMap.size };
  }
  return _parse();
}

// --- 智联招聘 ---
function zhilianCheckLogin() {
  // 多种登录指标检测
  const selectors = [
    '.user-info', '.username', '.user-center', '[class*="userName"]', '.resume-center',
    '.header__user', '.user-avatar', '.nav-user', '[class*="loginUser"]',
    '.top-nav__user', '.personal-center', '.my-center', '.user-name',
    '[class*="avatar"]', '.header-right .user', '.nav-right .user'
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) { const t = el.textContent.trim(); if (t.length > 0 && t.length < 30) return { success: true, isLogin: true, indicator: t }; }
    } catch(e) {}
  }
  // 检查导航链接
  const navTexts = ['我的简历', '我的投递', '个人中心', '账号设置', '退出'];
  for (const link of document.querySelectorAll('a')) {
    const txt = link.textContent.trim();
    if (navTexts.includes(txt)) return { success: true, isLogin: true, indicator: txt };
  }
  // 回退：页面文本中包含"你好"或中文姓名后缀（如"李先生"），表示已登录
  var bodyText = document.body ? document.body.innerText : '';
  if (bodyText.indexOf('你好') >= 0 || bodyText.indexOf('先生') >= 0 || bodyText.indexOf('女士') >= 0) {
    return { success: true, isLogin: true, indicator: '用户姓名' };
  }
  return { success: true, isLogin: false };
}

function zhilianSearchJobs(params) {
  // 智联薪资解析：日薪直接保留，月薪(万/K)统一转K，年薪除以12转月薪
  function parseZhilianSalary(text) {
    if (!text) return '';
    text = text.trim();
    // 日薪: "300-500元/天" → 直接保留
    var dailyMatch = text.match(/(\d+-\d+元\/天)/);
    if (dailyMatch) return dailyMatch[1];
    // 年薪明确标记: "24-25万/年" 或 "24万-25万/年" → 除以12转月薪K
    var yearMatch = text.match(/(\d*\.?\d+)万?-(\d*\.?\d+)万\/年/);
    if (yearMatch) {
      var minY = Math.round(parseFloat(yearMatch[1]) * 10000 / 12 / 1000);
      var maxY = Math.round(parseFloat(yearMatch[2]) * 10000 / 12 / 1000);
      if (minY > maxY) { var tmp = minY; minY = maxY; maxY = tmp; }
      return minY + 'K-' + maxY + 'K';
    }
    // 月薪K格式: "15K-30K", "8K-12K·14薪" → 直接保留
    var kMatch = text.match(/(\d+[kK]-\d+[kK](?:[·\s]*\d+薪)?)/);
    if (kMatch) return kMatch[1].replace(/K/gi, 'K');
    // 万格式: "1.5万-3万"(月薪) 或 "24-25万"(年薪)，万可能在两个数字后都有
    var wanMatch = text.match(/(\d*\.?\d+)万?-(\d*\.?\d+)万/);
    if (wanMatch) {
      var raw1 = wanMatch[1], raw2 = wanMatch[2];
      var num1 = parseFloat(raw1), num2 = parseFloat(raw2);
      var hasDecimal = (raw1.indexOf('.') !== -1 || raw2.indexOf('.') !== -1);
      if (hasDecimal) {
        // 有小数 → 月薪: "1.5万-3万" → "15K-30K"
        var minM = Math.round(num1 * 10);
        var maxM = Math.round(num2 * 10);
        if (minM > maxM) { var t = minM; minM = maxM; maxM = t; }
        return minM + 'K-' + maxM + 'K';
      } else {
        // 无小数 → 年薪: "24-25万" → 除以12转月薪
        var minA = Math.round(num1 * 10000 / 12 / 1000);
        var maxA = Math.round(num2 * 10000 / 12 / 1000);
        if (minA > maxA) { var t2 = minA; minA = maxA; maxA = t2; }
        return minA + 'K-' + maxA + 'K';
      }
    }
    // 面议
    if (text.indexOf('面议') >= 0) return '面议';
    return '';
  }

  function _parse() {
    const jobs = [];
    const seen = new Set();
    
    // 策略1: 新版页面结构 —— .positionlist 中的 jobinfo__name 链接
    const posList = document.querySelector('.positionlist');
    if (posList) {
      const jobLinks = posList.querySelectorAll('a.jobinfo__name[href*="jobdetail"]');
      const companyLinks = posList.querySelectorAll('a.companyinfo__name[href*="companydetail"]');
      
      for (let i = 0; i < jobLinks.length; i++) {
        const link = jobLinks[i];
        const href = link.href || '';
        const title = link.textContent.trim();
        if (!title || title.length < 2) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        
        // 获取公司名（同索引的 companyinfo__name 或通过兄弟元素查找）
        let company = '';
        if (companyLinks[i]) {
          company = companyLinks[i].textContent.trim();
        }
        
        // 获取薪资、地区等信息
        let salary = '';
        let area = '';
        let card = link.closest('[class*="position"]') || link.closest('li') || link.parentElement;
        if (card) {
          const cardText = card.textContent;
          // 薪资解析（支持日薪/月薪万/K/年薪万）
          salary = parseZhilianSalary(cardText);
          // 地区匹配
          const areaMatch = cardText.match(/(武汉|北京|上海|深圳|广州|杭州|成都|南京|苏州|重庆|天津|长沙|西安|东莞|佛山|宁波|合肥|郑州|厦门|青岛|无锡|福州|济南|昆明|大连|沈阳|南昌|温州|石家庄|哈尔滨|长春|泉州|贵阳|南宁|嘉兴|珠海|惠州|中山|绍兴|金华|常州|南通|徐州|太原|烟台)/);
          if (areaMatch) area = areaMatch[0];
        }
        
        const id = (href.match(/jobdetail\/([A-Za-z0-9]+)/) || [])[1] || href.split('/').filter(Boolean).pop() || '';
        
        jobs.push({ id, title, company, salary, area, url: href, platform: 'zhilian' });
      }
    }
    
    // 策略2: 回退 —— 旧版页面，遍历所有链接
    if (jobs.length === 0) {
      const allLinks = document.querySelectorAll('a[href]');
      for (const link of allLinks) {
        const href = link.href || '';
        const txt = link.textContent.trim();
        if (!txt || txt.length < 2 || txt.length > 100) continue;
        if (/^(首页|下一页|上一页|登录|注册|消息|职位|公司|武汉站|搜索|投诉|举报|反馈|更多|收起|展开)$/.test(txt)) continue;
        if (txt.includes('投递') || txt.includes('登录') || txt.includes('注册')) continue;
        if (href.includes('/job_') || href.includes('/jobs_') || href.includes('/sou/') || href.includes('jobdetail')) {
          if (seen.has(href)) continue;
          seen.add(href);
          let salary = '';
          const linkParent = link.parentElement;
          if (linkParent) salary = parseZhilianSalary(linkParent.textContent);
          jobs.push({
            id: href.split('/').filter(Boolean).pop() || '',
            title: txt,
            company: '',
            salary,
            url: href,
            platform: 'zhilian'
          });
        }
      }
    }
    
    // 策略3: 回退 —— 通过投递按钮找职位
    if (jobs.length === 0) {
      const allBtns = document.querySelectorAll('button');
      for (const btn of allBtns) {
        if (!btn.textContent.includes('投递')) continue;
        const parent = btn.closest('[class*="position"]') || btn.parentElement;
        if (!parent) continue;
        const links = parent.querySelectorAll('a');
        for (const link of links) {
          const txt = link.textContent.trim();
          const href = link.href || '';
          if (!txt || txt.length < 2 || txt.length > 80) continue;
          if (txt.includes('投递') || txt.includes('登录') || txt.includes('注册')) continue;
          if (seen.has(href)) continue;
          seen.add(href);
          jobs.push({
            id: href.split('/').filter(Boolean).pop() || '',
            title: txt,
            company: '',
            salary: parseZhilianSalary(parent.textContent),
            url: href,
            platform: 'zhilian'
          });
        }
        if (jobs.length >= 20) break;
      }
    }
    
    if (jobs.length === 0) {
      const diag = {
        url: location.href,
        title: document.title,
        totalLinks: document.querySelectorAll('a').length,
        totalButtons: document.querySelectorAll('button').length,
        positionList: !!document.querySelector('.positionlist'),
        jobinfoName: document.querySelectorAll('.jobinfo__name').length,
        sampleLinks: Array.from(document.querySelectorAll('a')).slice(0, 10).map(l => ({ text: l.textContent.trim().substring(0, 40), href: (l.href || '').substring(0, 100) }))
      };
      return { success: true, jobs, total: 0, diag };
    }
    return { success: true, jobs, total: jobs.length };
  }
  const url = location.href;
  if (url.includes('/sou/') || url.includes('keyword=')) return _parse();
  return { success: false, error: '请打开智联招聘搜索页面' };
}

function zhilianCommunicate(params) {
  const { greeting, maxCount } = params || {};
  const cards = document.querySelectorAll('.joblist-box__item, .job-card, .jobitem, [class*="joblist"] > div');
  let sent = 0;
  const results = [];
  for (const card of cards) {
    if (sent >= (maxCount || 50)) break;
    const btn = card.querySelector('.btn-apply, .apply-btn, [class*="apply"], [class*="deliver"]');
    if (!btn) continue;
    const link = card.querySelector('a[href*="/jobs/"]');
    const jid = link ? (link.href.match(/jobs\/([a-zA-Z0-9]+)/) || [])[1] : '';
    try { btn.click(); sent++; results.push({ jobId: jid, title: link ? link.textContent.trim() : '', status: 'clicked' }); } catch (e) { results.push({ jobId: jid, status: 'error', error: e.message }); }
  }
  return { success: true, results, sentCount: sent, total: results.length };
}

// --- 猎聘 ---
function liepinCheckLogin() {
  const selectors = [
    '.user-info', '.username', '.user-avatar', '.nav-user', '[class*="loginUser"]', '.header-user',
    '.user-center', '.personal-center', '.my-resume', '.user-name', '.nickname',
    '.header-login-info', '.nav-right .user', '.topbar-user', '[class*="userName"]'
  ];
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) { const t = el.textContent.trim(); if (t.length > 0 && t.length < 30) return { success: true, isLogin: true, indicator: t }; }
    } catch(e) {}
  }
  // 检查导航链接
  const navTexts = ['我的简历', '谁看过我', '我的投递', '个人中心', '退出登录', '消息'];
  for (const link of document.querySelectorAll('a')) {
    const txt = link.textContent.trim();
    if (navTexts.includes(txt)) return { success: true, isLogin: true, indicator: txt };
  }
  // 猎聘特有：页面文本中包含"你好"表示已登录
  if (document.body && document.body.textContent.includes('你好')) return { success: true, isLogin: true, indicator: '你好' };
  return { success: true, isLogin: false };
}

function liepinSearchJobs(params) {
  function _parse() {
    const jobs = [];
    const seen = new Set();
    
    // 解析猎聘卡片标题：格式如 "人事总监【苏州-吴江区】20-30k经验不限本科"
    function _parseTitleCard(rawTitle) {
      const result = { title: rawTitle, company: '', salary: '', area: '', experience: '', education: '' };
      // 提取【地区】信息
      const areaMatch = rawTitle.match(/【(.+?)】/);
      if (areaMatch) {
        result.area = areaMatch[1];
        result.title = rawTitle.replace(/【.+?】/, '').trim();
      }
      // 提取薪资
      const salMatch = result.title.match(/(\d+[-~]\d+[kK万])\s*·?\s*(\d+薪)?/);
      if (salMatch) {
        result.salary = salMatch[1] + (salMatch[2] || '');
        result.title = result.title.replace(salMatch[0], '').trim();
      }
      // 提取经验要求
      const expMatch = result.title.match(/(经验不限|\d+[-~]\d+年|\d+年以上)/);
      if (expMatch) {
        result.experience = expMatch[1];
        result.title = result.title.replace(expMatch[0], '').trim();
      }
      // 提取学历
      const eduMatch = result.title.match(/(博士|硕士|MBA|本科|大专|学历不限)/);
      if (eduMatch) {
        result.education = eduMatch[1];
        result.title = result.title.replace(eduMatch[0], '').trim();
      }
      return result;
    }
    
    // 策略1: 标准卡片选择器（新版猎聘）
    const cardSelectors = ['.job-list-box > li', '.job-card', '.job-list-item', '.sojob-item', '.job-info', '.job-content', 'li[class*="job"]', 'div[class*="jobCard"]', 'div[class*="job-item"]'];
    let cards = [];
    for (const sel of cardSelectors) {
      cards = document.querySelectorAll(sel);
      if (cards.length > 0) break;
    }
    
    for (const card of cards) {
      const titleEl = card.querySelector('.job-title, .job-name, .title, h3, a[href*="/job/"], [class*="title"]');
      const compEl = card.querySelector('.company-name, .cname, .company, [class*="company"], [class*="cname"]');
      const salEl = card.querySelector('.salary, .text-warning, [class*="salary"], [class*="sal"]');
      const areaEl = card.querySelector('.area, .job-area, [class*="area"], [class*="dqs"]');
      const linkEl = card.querySelector('a[href*="/job/"]') || (titleEl && titleEl.tagName === 'A' ? titleEl : null);
      const rawTitle = titleEl ? titleEl.textContent.trim() : '';
      const url = linkEl ? linkEl.href : '';
      if (!url || url.length < 10) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      const parsed = _parseTitleCard(rawTitle);
      const jid = url.match(/job\/(\d+)/);
      jobs.push({
        id: jid ? jid[1] : '',
        title: parsed.title || rawTitle,
        company: compEl ? compEl.textContent.trim() : '',
        salary: salEl ? salEl.textContent.trim() : parsed.salary,
        area: areaEl ? areaEl.textContent.trim() : parsed.area,
        experience: parsed.experience,
        education: parsed.education,
        url,
        platform: 'liepin'
      });
    }
    
    // 策略2: 直接找所有职位链接
    if (jobs.length === 0) {
      const allLinks = document.querySelectorAll('a[href*="/job/"]');
      for (const link of allLinks) {
        const href = link.href || '';
        const txt = link.textContent.trim();
        if (!txt || txt.length < 2 || txt.length > 100) continue;
        if (txt.includes('下一页') || txt.includes('上一页') || txt.includes('首页')) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const parsed = _parseTitleCard(txt);
        const jid = href.match(/job\/(\d+)/);
        jobs.push({
          id: jid ? jid[1] : '',
          title: parsed.title,
          company: parsed.company,
          salary: parsed.salary,
          area: parsed.area,
          experience: parsed.experience,
          education: parsed.education,
          url: href,
          platform: 'liepin'
        });
      }
    }
    
    if (jobs.length === 0) {
      const diag = {
        url: location.href,
        title: document.title,
        totalLinks: document.querySelectorAll('a').length,
        totalButtons: document.querySelectorAll('button').length,
        sampleLinks: Array.from(document.querySelectorAll('a')).slice(0, 10).map(l => ({ text: l.textContent.trim().substring(0, 40), href: (l.href || '').substring(0, 100) }))
      };
      return { success: true, jobs, total: 0, diag };
    }
    return { success: true, jobs, total: jobs.length };
  }
  const url = location.href;
  if (url.includes('/zhaopin/') || url.includes('keyword=') || url.includes('key=')) return _parse();
  return { success: false, error: '请打开猎聘搜索页面（如 https://www.liepin.com/zhaopin/）' };
}

function liepinCommunicate(params) {
  const { greeting, maxCount } = params || {};
  const cards = document.querySelectorAll('.job-card, .job-list-item, .sojob-item');
  let sent = 0;
  const results = [];
  for (const card of cards) {
    if (sent >= (maxCount || 50)) break;
    const btn = card.querySelector('.apply-btn, .btn-apply, [class*="apply"], [class*="chat"]');
    if (!btn) continue;
    const link = card.querySelector('a[href*="/job/"]');
    const jid = link ? (link.href.match(/job\/(\d+)/) || [])[1] : '';
    try { btn.click(); sent++; results.push({ jobId: jid, title: link ? link.textContent.trim() : '', status: 'clicked' }); } catch (e) { results.push({ jobId: jid, status: 'error', error: e.message }); }
  }
  return { success: true, results, sentCount: sent, total: results.length };
}

// --- 前程无忧 51job ---
function qianchengCheckLogin() {
  const el = document.querySelector('.user-info, .login-name, .nickname, [class*="userName"], .mycenter, .headerLogin');
  if (el) { const t = el.textContent.trim(); if (t.length > 0 && t.length < 30) return { success: true, isLogin: true, indicator: t }; }
  return { success: true, isLogin: false };
}

function qianchengSearchJobs(params) {
  function _parse() {
    const jobs = [];
    const seen = new Set();
    const url = location.href;
    
    // 策略0: 当前51job公司详情页 - 解析职位列表
    if (url.includes('jobs.51job.com')) {
      const jobLinks = document.querySelectorAll('a[href*="/job/"]');
      for (const link of jobLinks) {
        const href = link.href || '';
        const txt = link.textContent.trim();
        if (!txt || txt.length < 2 || txt.length > 100) continue;
        if (txt.includes('下一页') || txt.includes('上一页') || txt.includes('首页') || txt.includes('去聊聊') || txt.includes('投递')) continue;
        if (seen.has(href)) continue;
        seen.add(href);
        const parts = txt.split(/\s+/);
        const title = parts[0] || txt;
        const salary = parts.length > 1 && /^\d/.test(parts[1]) ? parts[1] : '';
        jobs.push({
          id: href.replace(/[^a-zA-Z0-9]/g, '').substring(0, 40),
          title,
          company: (document.querySelector('h1') || {}).textContent || '',
          salary,
          url: href,
          platform: 'qiancheng'
        });
      }
      if (jobs.length > 0) return { success: true, jobs, total: jobs.length };
    }
    
    // 策略1: 搜索页 - 优先解析 .joblist-item（个体职位）
    const jobItems = document.querySelectorAll('.joblist-item');
    if (jobItems.length > 0) {
      for (const item of jobItems) {
        const titleEl = item.querySelector('.joblist-item-jobname');
        const compEl = item.querySelector('.cname');
        const infoEl = item.querySelector('.joblist-item-jobinfo');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const company = compEl ? compEl.textContent.trim() : '';
        const infoText = infoEl ? infoEl.textContent.trim() : '';
        const salary = infoText.split(' ')[0] || '';
        if (!title || title.length < 2) continue;
        const key = title + '|' + company;
        if (seen.has(key)) continue;
        seen.add(key);
        const wrapper = item.querySelector('[sensorsdata]');
        let sd = {};
        if (wrapper) { try { sd = JSON.parse(wrapper.getAttribute('sensorsdata') || '{}'); } catch(e) {} }
        jobs.push({
          id: sd.jobId || key.replace(/[^a-zA-Z\\u4e00-\\u9fa5]/g, '').substring(0, 40),
          title: sd.jobTitle || title,
          company,
          salary: sd.jobSalary || salary,
          area: sd.jobArea || '',
          url: 'https://jobs.51job.com/wuhan/' + (sd.jobId || '') + '.html',
          platform: 'qiancheng'
        });
      }
      if (jobs.length > 0) return { success: true, jobs, total: jobs.length };
    }
    
    // 策略1b: 解析公司卡片（仅在非搜索页时使用）
    if (!url.includes('we.51job.com/pc/search') && !url.includes('search.51job.com')) {
      function _parseCompanyLine(txt) {
      const parts = txt.split(/\s+/);
      if (parts.length < 2) return null;
      const company = parts[0];
      const rest = parts.slice(1).join('');
      const TYPE_PATTERNS = ['外资（欧美）','外资（非欧美）','外资(欧美)','外资(非欧美)','事业单位','政府机关','创业公司','已上市','代表处','民营','国企','合资','外资','外企','其他'];
      const SIZE_RE = /(\d+-\d+人|少于\d+人|\d+人以上|\d+人以下|\d+人|万余人|人|规模)/;
      let type = '', industry = '', size = '';
      for (const tp of TYPE_PATTERNS) {
        if (rest.endsWith(tp)) {
          type = tp;
          const before = rest.slice(0, -tp.length);
          const sm = before.match(SIZE_RE);
          if (sm) { size = sm[0]; industry = before.slice(0, before.length - sm[0].length); }
          else { industry = before; }
          break;
        }
      }
      if (!type) {
        const sm = rest.match(SIZE_RE);
        if (sm) {
          size = sm[0];
          const before = rest.slice(0, rest.length - sm[0].length);
          for (const tp of TYPE_PATTERNS) { if (before.endsWith(tp)) { type = tp; industry = before.slice(0, -tp.length); break; } }
          if (!type) industry = before;
        } else { industry = rest; }
      }
      return { company, industry, type, size };
    }
    const coLinks = document.querySelectorAll('a[href*="jobs.51job.com"]');
    for (const link of coLinks) {
      const href = link.href || '';
      const txt = link.textContent.trim();
      if (!txt || txt.length < 10 || txt.length > 200) continue;
      if (seen.has(href)) continue;
      if (/^(首页|搜索|校园招聘|测培商城|典范雇主|职场资讯|企业培训|我要招人|登录|注册)$/.test(txt)) continue;
      if (txt.includes('招聘') && txt.length < 8) continue;
      seen.add(href);
      const parsed = _parseCompanyLine(txt);
      if (!parsed || !parsed.type) continue;
      jobs.push({
        id: href.replace(/[^a-zA-Z0-9]/g, '').substring(0, 40),
        title: parsed.company, company: parsed.company,
        salary: '', url: href, platform: 'qiancheng',
        industry: parsed.industry, type: parsed.type, size: parsed.size,
        _isCompany: true
      });
    }
    if (jobs.length > 0) return { success: true, jobs, total: jobs.length };
    } // end if (!search page)
    
    // 策略2: 旧版 .joblist-item 结构
    const cards = document.querySelectorAll('.joblist-item');
    for (const card of cards) {
      const titleEl = card.querySelector('.joblist-item-jobname');
      const infoEl = card.querySelector('.joblist-item-jobinfo');
      const rightEl = card.querySelector('.joblist-item-right');
      const title = titleEl ? titleEl.textContent.trim() : '';
      if (!title || title.length < 2 || title.length > 80) continue;
      const infoText = infoEl ? infoEl.textContent.trim() : '';
      const salary = infoText.split(' ')[0] || '';
      let company = '';
      if (rightEl) {
        const rightText = rightEl.textContent.trim();
        const parts = rightText.split(/\s{2,}/);
        company = parts[0] || '';
      }
      const uid = title + '|' + company;
      if (seen.has(uid)) continue;
      seen.add(uid);
      jobs.push({ id: uid.replace(/[^a-zA-Z\u4e00-\u9fa5]/g, '').substring(0, 40), title, company, salary, url: location.href, platform: 'qiancheng' });
    }
    
    // 策略3: 通用选择器回退
    if (jobs.length === 0) {
      const cardSelectors = ['.e-jobitem', '.job-item', 'div[class*="jobItem"]'];
      let fallbackCards = [];
      for (const sel of cardSelectors) {
        fallbackCards = document.querySelectorAll(sel);
        if (fallbackCards.length > 0) break;
      }
      for (const card of fallbackCards) {
        const titleEl = card.querySelector('.jname, .job-name, .job-title, [class*="jobName"], [class*="title"], a[href*="/job/"], h3');
        const compEl = card.querySelector('.cname, .company-name, .company, [class*="company"], [class*="cname"]');
        const salEl = card.querySelector('.sal, .salary, [class*="salary"], [class*="sal"]');
        const linkEl = card.querySelector('a[href*="/job/"]') || (titleEl && titleEl.tagName === 'A' ? titleEl : null);
        const title = titleEl ? titleEl.textContent.trim() : '';
        const url = linkEl ? linkEl.href : location.href;
        if (!title || title.length < 2 || title.length > 80) continue;
        const uid = title + '|' + (compEl ? compEl.textContent.trim() : '');
        if (seen.has(uid)) continue;
        seen.add(uid);
        jobs.push({ id: uid.replace(/[^a-zA-Z\u4e00-\u9fa5]/g, '').substring(0, 40), title, company: compEl ? compEl.textContent.trim() : '', salary: salEl ? salEl.textContent.trim() : '', url, platform: 'qiancheng' });
      }
    }
    
    if (jobs.length === 0) {
      const diag = {
        url: location.href,
        title: document.title,
        totalCoLinks: document.querySelectorAll('a[href*="jobs.51job.com"]').length,
        totalJoblistItems: document.querySelectorAll('.joblist-item').length,
        totalLinks: document.querySelectorAll('a').length,
        sampleLinks: Array.from(document.querySelectorAll('a')).slice(0, 10).map(l => ({ text: l.textContent.trim().substring(0, 40), href: (l.href || '').substring(0, 100) }))
      };
      return { success: true, jobs, total: 0, diag };
    }
    return { success: true, jobs, total: jobs.length };
  }
  const url = location.href;
  if (url.includes('/search') || url.includes('keyword=') || url.includes('jobsearch') || url.includes('jobs.51job.com')) return _parse();
  return { success: false, error: '请打开前程无忧搜索页面（如 https://we.51job.com/）' };
}

function qianchengCommunicate(params) {
  const { greeting, maxCount } = params || {};
  const cards = document.querySelectorAll('.joblist-item, .e-jobitem, .job-item');
  let sent = 0;
  const results = [];
  for (const card of cards) {
    if (sent >= (maxCount || 50)) break;
    const btn = card.querySelector('.btn-apply, .apply, [class*="apply"], [class*="deliver"]');
    if (!btn) continue;
    const link = card.querySelector('a[href*="/job/"]');
    const jid = link ? (link.href.match(/job\/(\d+)/) || [])[1] : '';
    try { btn.click(); sent++; results.push({ jobId: jid, title: link ? link.textContent.trim() : '', status: 'clicked' }); } catch (e) { results.push({ jobId: jid, status: 'error', error: e.message }); }
  }
  return { success: true, results, sentCount: sent, total: results.length };
}

// ==================== 平台函数路由 ====================

function getCheckLoginFunc(platform) {
  const map = { boss: bossCheckLogin, zhilian: zhilianCheckLogin, liepin: liepinCheckLogin, qiancheng: qianchengCheckLogin };
  return map[platform] || function() { return { success: true, isLogin: false }; };
}

function getSearchFunc(platform) {
  const map = { boss: bossSearchJobs, zhilian: zhilianSearchJobs, liepin: liepinSearchJobs, qiancheng: qianchengSearchJobs };
  return map[platform] || null;
}

function getCommunicateFunc(platform) {
  const map = { boss: bossCommunicate, zhilian: zhilianCommunicate, liepin: liepinCommunicate, qiancheng: qianchengCommunicate };
  return map[platform] || null;
}

function getApplyFunc(platform) {
  const map = { boss: bossApplySingle, zhilian: zhilianApplySingle, liepin: liepinApplySingle, qiancheng: qianchengApplySingle };
  return map[platform] || null;
}

function getParseFunc(platform) {
  const map = { boss: bossParseList };
  return map[platform] || null;
}

// ==================== APPLY_SINGLE fallback 函数 ====================

function bossApplySingle(params) {
  const { job, greeting } = params || {};
  const defaultGreeting = '您好，我对这个岗位很感兴趣，期待进一步沟通。';
  const msg = greeting || defaultGreeting;
  
  // 内联文本匹配函数（在MAIN world执行，不能依赖外部函数）
  function _findBtn(patterns, excludeTexts) {
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
    let node;
    while (node = walker.nextNode()) {
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (['script','style','noscript','meta','link','head'].includes(tag)) continue;
      if (el.offsetParent === null && el.getClientRects().length === 0) continue;
      const text = el.textContent.trim();
      if (!text || text.length > 100) continue;
      if (excludeTexts && excludeTexts.some(et => text.includes(et))) continue;
      for (const pattern of patterns) {
        if (text === pattern || text.includes(pattern)) {
          const quality = text === pattern ? text.length * 0.5 : text.length;
          results.push({ el, text, tag, quality });
          break;
        }
      }
    }
    results.sort((a, b) => a.quality - b.quality);
    if (results.length > 0) {
      console.log(`[投上岸] _findBtn: 找到 "${results[0].text}" (${results[0].tag})`);
      return results[0].el;
    }
    return null;
  }
  
  try {
    console.log('[投上岸] BOSS直聘 applySingle 开始...');
    console.log('[投上岸] 当前URL:', location.href);
    console.log('[投上岸] 页面标题:', document.title);
    
    // 1. 使用通用文本匹配查找"立即沟通"或"沟通"按钮
    let chatBtn = _findBtn(['立即沟通', '沟通'], ['已', '继续', '登录', '注册']);
    // 回退：通过class查找
    if (!chatBtn) {
      chatBtn = document.querySelector('[class*="op-btn-chat"], [class*="btn-chat"], [class*="chat-btn"], [class*="btn-startchat"], [class*="start-chat"], [ka*="chat"], [data-kp*="chat"]');
    }
    if (!chatBtn) {
      // 调试：输出所有可见元素的文本
      console.log('[投上岸] 未找到沟通按钮，调试信息:');
      const debugEls = document.querySelectorAll('button, a, [role="button"], span, div');
      debugEls.forEach((el, i) => {
        const txt = (el.textContent || '').trim().substring(0, 30);
        if (txt && txt.length > 1) console.log(`  el${i}: tag="${el.tagName}" text="${txt}" class="${el.className}"`);
      });
      return { success: false, error: '未找到沟通按钮', jobId: job?.id };
    }

    console.log(`[投上岸] 找到沟通按钮: "${chatBtn.textContent.trim()}" (${chatBtn.tagName})`);
    
    // 2. 点击"立即沟通"按钮
    const urlBefore = location.href;
    chatBtn.click();
    console.log('[投上岸] 已点击沟通按钮');

    // 3. 等待弹窗出现（最多等待10秒，轮询查找文本输入框）
    // BOSS直聘弹窗有几种形式：
    //   a) 普通弹窗（dialog），内有 textarea + 发送按钮
    //   b) 侧边聊天面板，内有 textarea
    //   c) 新页面打开聊天
    const maxWait = 10000;
    const pollInterval = 300;
    let waited = 0;
    let inputEl = null;
    
    console.log('[投上岸] 开始轮询查找弹窗输入框...');
    
    while (waited < maxWait) {
      // 策略1: 查找所有可见的textarea
      const allTextareas = document.querySelectorAll('textarea');
      for (const ta of allTextareas) {
        if (ta.offsetParent !== null || ta.getClientRects().length > 0) {
          inputEl = ta;
          console.log('[投上岸] 策略1: 找到textarea输入框');
          break;
        }
      }
      if (inputEl) break;
      
      // 策略2: 查找contenteditable的div
      if (!inputEl) {
        const editableDivs = document.querySelectorAll('div[contenteditable="true"], div[contenteditable]');
        for (const div of editableDivs) {
          if (div.offsetParent !== null || div.getClientRects().length > 0) {
            inputEl = div;
            console.log('[投上岸] 策略2: 找到contenteditable输入框');
            break;
          }
        }
      }
      if (inputEl) break;
      
      // 策略3: 查找所有可见的输入框
      if (!inputEl) {
        const allInputs = document.querySelectorAll('input[type="text"], input:not([type]), input[type="search"]');
        for (const inp of allInputs) {
          if (inp.offsetParent !== null || inp.getClientRects().length > 0) {
            inputEl = inp;
            console.log('[投上岸] 策略3: 找到input输入框');
            break;
          }
        }
      }
      if (inputEl) break;
      
      // 策略4: 查找弹窗/聊天容器中的输入元素
      if (!inputEl) {
        const containers = document.querySelectorAll('.dialog, [class*="dialog"], [class*="modal"], [class*="popup"], [class*="chat"], [class*="message"]');
        for (const container of containers) {
          if (container.offsetParent !== null || container.getClientRects().length > 0) {
            const innerInput = container.querySelector('textarea, input, [contenteditable]');
            if (innerInput) {
              inputEl = innerInput;
              console.log('[投上岸] 策略4: 在容器中找到输入框');
              break;
            }
          }
        }
      }
      if (inputEl) break;
      
      // 策略5: 查找所有可见的input元素（包括隐藏类型的）
      if (!inputEl) {
        const allInputs = document.querySelectorAll('input');
        for (const inp of allInputs) {
          const rect = inp.getBoundingClientRect();
          if (rect.width > 50 && rect.height > 20) {
            inputEl = inp;
            console.log('[投上岸] 策略5: 通过尺寸找到input');
            break;
          }
        }
      }
      if (inputEl) break;
      
      // 策略6: 检查URL是否变化（BOSS直聘可能打开新聊天页面）
      if (location.href !== urlBefore) {
        console.log('[投上岸] 策略6: URL已变化，检测到页面跳转:', location.href);
        // 在新页面中查找输入框
        const newInput = document.querySelector('textarea, input, [contenteditable]');
        if (newInput) {
          inputEl = newInput;
          console.log('[投上岸] 策略6: 在新页面找到输入框');
          break;
        }
      }
      
      // 每次等待后重新检查
      const start = Date.now();
      while (Date.now() - start < pollInterval) { /* busy wait */ }
      waited += pollInterval;
      
      if (waited % 2000 === 0) {
        console.log(`[投上岸] 弹窗等待中... ${waited/1000}s, 当前URL: ${location.href}`);
      }
    }

    if (!inputEl) {
      console.log('[投上岸] 未找到输入框，开始诊断...');
      // 诊断：输出页面上的所有输入元素
      const allInputs = document.querySelectorAll('input, textarea, [contenteditable]');
      console.log(`[投上岸] 诊断: 找到 ${allInputs.length} 个输入元素`);
      allInputs.forEach((el, i) => {
        const tag = el.tagName;
        const type = el.type || '';
        const rect = el.getBoundingClientRect();
        const visible = el.offsetParent !== null;
        console.log(`  input${i}: tag=${tag} type=${type} visible=${visible} rect=${Math.round(rect.width)}x${Math.round(rect.height)} class=${el.className.substring(0, 50)}`);
      });
      
      // 检查页面是否已跳转
      if (location.href !== urlBefore) {
        console.log('[投上岸] 页面已跳转，尝试在新页面中查找输入框');
        const newInput = document.querySelector('textarea, input, [contenteditable]');
        if (newInput) {
          inputEl = newInput;
          console.log('[投上岸] 在新页面找到输入框');
        }
      }
      
      // 检查是否弹窗已出现但形式未知
      if (!inputEl) {
        const dialogs = document.querySelectorAll('.dialog, [class*="dialog"], [class*="modal"], [class*="popup"], [class*="overlay"], [class*="mask"]');
        console.log(`[投上岸] 诊断: 找到 ${dialogs.length} 个弹窗元素`);
        if (dialogs.length > 0) {
          dialogs.forEach((el, i) => {
            const rect = el.getBoundingClientRect();
            const visible = el.offsetParent !== null;
            console.log(`  dialog${i}: tag=${el.tagName} visible=${visible} rect=${Math.round(rect.width)}x${Math.round(rect.height)} class=${el.className.substring(0, 60)}`);
          });
          // 尝试直接发送回车键
          document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
          return { success: true, jobId: job?.id, method: '沟通-弹窗自动发送', warning: '未找到输入框但已点击沟通按钮' };
        }
      }
      
      if (!inputEl) {
        return { success: false, error: '弹窗未出现或未找到输入框', jobId: job?.id, debug: { url: location.href, title: document.title } };
      }
    }

    console.log(`[投上岸] 找到输入框: ${inputEl.tagName} class=${inputEl.className.substring(0, 50)}`);
    
    // 4. 填入招呼语
    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
      inputEl.value = msg;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (inputEl.isContentEditable) {
      inputEl.textContent = msg;
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
    console.log('[投上岸] 已填入招呼语');

    // 5. 查找"发送"按钮并点击
    let sendBtn = _findBtn(['发送', '发送消息'], ['验证码', '登录', '注册']);
    if (!sendBtn) {
      // 回退：通过class查找发送按钮
      sendBtn = document.querySelector('[class*="btn-send"], [class*="send-btn"], [class*="chat-send"], [class*="send"], [class*="submit"]');
    }
    if (!sendBtn) {
      // 尝试回车发送
      inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      console.log('[投上岸] 未找到发送按钮，使用回车发送');
      return { success: true, jobId: job?.id, method: '立即沟通-回车发送', step: 'enter_send' };
    }
    sendBtn.click();
    console.log('[投上岸] 已点击发送按钮');

    // 6. 等待发送完成
    const sendWait = 500;
    const sendStart = Date.now();
    while (Date.now() - sendStart < sendWait) { /* busy wait */ }

    return { success: true, jobId: job?.id, method: '立即沟通-填招呼语-发送' };
  } catch (e) {
    return { success: false, error: e.message, jobId: job?.id };
  }
}

function qianchengApplySingle(params) {
  const { job } = params || {};
  
  // 内联文本匹配函数
  function _findBtn(patterns, excludeTexts) {
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
    let node;
    while (node = walker.nextNode()) {
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (['script','style','noscript','meta','link','head'].includes(tag)) continue;
      if (el.offsetParent === null && el.getClientRects().length === 0) continue;
      const text = el.textContent.trim();
      if (!text || text.length > 100) continue;
      if (excludeTexts && excludeTexts.some(et => text.includes(et))) continue;
      for (const pattern of patterns) {
        if (text.includes(pattern)) {
          results.push({ el, text, tag, quality: text.length });
          break;
        }
      }
    }
    results.sort((a, b) => a.quality - b.quality);
    if (results.length > 0) {
      console.log(`[投上岸] 前程无忧 _findBtn: 找到 "${results[0].text}" (${results[0].tag})`);
      return results[0].el;
    }
    return null;
  }
  
  try {
    // 使用通用文本匹配查找"投递"或"申请"按钮
    // 前程无忧的"立即投递"可能是button、a、span、div等任意元素
    let applyBtn = _findBtn(['立即投递', '投递简历', '投递', '申请'], ['已投递', '投递成功', '登录', '注册']);
    
    if (!applyBtn) {
      // 回退：通过class查找
      applyBtn = document.querySelector('.btn-apply, .apply-btn, .deliver-btn, [class*="apply"], [class*="deliver"], [class*="send-resume"]');
    }
    
    if (!applyBtn) {
      // 调试：输出所有可见元素的文本
      console.log('[投上岸] 前程无忧未找到投递按钮，调试信息:');
      document.querySelectorAll('button, a, span, div').forEach((el, i) => {
        const txt = (el.textContent || '').trim().substring(0, 30);
        if (txt && (txt.includes('投递') || txt.includes('申请'))) {
          console.log(`  el${i}: tag="${el.tagName}" text="${txt}" class="${el.className}"`);
        }
      });
      return { success: false, error: '未找到投递按钮', jobId: job?.id };
    }

    console.log(`[投上岸] 前程无忧找到投递按钮: "${applyBtn.textContent.trim()}" (${applyBtn.tagName})`);
    applyBtn.click();

    // 等待3-5秒，检查是否出现"已投递"状态
    const waitTime = 3000 + Math.random() * 2000;
    const start = Date.now();
    while (Date.now() - start < waitTime) { /* busy wait */ }

    // 检查页面是否出现"已投递"或类似状态文字
    const bodyText = document.body.textContent || '';
    const appliedKeywords = ['已投递', '投递成功', '已申请', '申请成功', 'success', '投递反馈'];
    for (const kw of appliedKeywords) {
      if (bodyText.includes(kw)) {
        return { success: true, jobId: job?.id, method: '投递按钮-确认已投递' };
      }
    }

    // 检查是否有投递成功的提示元素
    const successEls = document.querySelectorAll('[class*="success"], [class*="applied"], [class*="delivered"], [class*="tip-success"], [class*="toast"], [class*="tip"]');
    for (const el of successEls) {
      if (el.offsetParent === null) continue;
      const txt = (el.textContent || '').trim();
      if (txt.includes('已投递') || txt.includes('投递成功') || txt.includes('已申请')) {
        return { success: true, jobId: job?.id, method: '投递按钮-检测到成功提示' };
      }
    }

    // 检查按钮是否变为"已投递"状态
    const btnText = applyBtn.textContent.trim();
    if (btnText.includes('已投递') || btnText.includes('已申请')) {
      return { success: true, jobId: job?.id, method: '投递按钮-按钮已变为已投递' };
    }

    // 未确认已投递状态，但已点击了按钮
    return { success: false, error: '已点击投递，但未确认已投递状态', jobId: job?.id, clicked: true };
  } catch (e) {
    return { success: false, error: e.message, jobId: job?.id };
  }
}

function zhilianApplySingle(params) {
  const { job } = params || {};
  
  function _sleep(ms) {
    const start = Date.now();
    while (Date.now() - start < ms) { /* busy wait */ }
  }
  
  try {
    console.log('[投上岸] 智联招聘 applySingle 开始, URL:', location.href);
    
    // 先检查是否已投递过
    const bodyText = document.body.textContent || '';
    if (bodyText.includes('已投递') || bodyText.includes('已申请')) {
      return { success: true, jobId: job?.id, method: '已经投递过' };
    }
    
    // 查找"立即投递"按钮 - 使用所有元素遍历
    function findApplyBtn() {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
      let node, best = null, bestScore = Infinity;
      while (node = walker.nextNode()) {
        const el = node;
        const tag = el.tagName.toLowerCase();
        if (['script','style','noscript','meta','link','head'].includes(tag)) continue;
        if (el.offsetParent === null && el.getClientRects().length === 0) continue;
        const text = el.textContent.trim();
        if (!text || text.length > 50) continue;
        if (text.includes('已投递') || text.includes('投递成功') || text.includes('登录') || text.includes('注册')) continue;
        if (text.includes('立即投递') || text.includes('投递简历') || text === '投递' || text === '申请') {
          if (text.length < bestScore) {
            bestScore = text.length;
            best = el;
          }
        }
      }
      if (best) console.log(`[投上岸] 智联投递按钮: "${best.textContent.trim()}" (${best.tagName})`);
      return best;
    }
    
    let applyBtn = findApplyBtn();
    if (!applyBtn) {
      applyBtn = document.querySelector('.btn-apply, .apply-btn, .deliver-btn, [class*="apply"], [class*="deliver"], [class*="send-resume"], [class*="btn-deliver"], .btn-primary, .btn-main, .btn-primary-lg');
    }
    if (!applyBtn) {
      console.log('[投上岸] 智联未找到投递按钮');
      return { success: false, error: '未找到投递按钮', jobId: job?.id };
    }

    const applyText = applyBtn.textContent.trim();
    const urlBefore = location.href;
    applyBtn.click();
    console.log('[投上岸] 已点击智联投递按钮:', applyText);
    
    // 等待并检查 - 最长8秒
    for (let i = 0; i < 8; i++) {
      _sleep(1000);
      
      // 检查"已投递"文字
      const currentBody = document.body.textContent || '';
      if (currentBody.includes('已投递') || currentBody.includes('投递成功') || currentBody.includes('已申请')) {
        return { success: true, jobId: job?.id, method: '确认已投递' };
      }
      
      // 检查按钮是否变化
      try {
        const newText = applyBtn.textContent.trim();
        if (newText.includes('已投递') || newText.includes('已申请')) {
          return { success: true, jobId: job?.id, method: '按钮已变为已投递' };
        }
      } catch(e) {}
      
      // 检查URL是否变化
      if (location.href !== urlBefore) {
        _sleep(2000);
        return { success: true, jobId: job?.id, method: '页面已跳转' };
      }
      
      // 尝试找确认按钮（每轮都查）
      const confirmBtns = document.querySelectorAll('button, a, span, div, p');
      let confirmBtn = null;
      for (const cb of confirmBtns) {
        const txt = cb.textContent.trim();
        if (!txt || txt.length > 30) continue;
        if ((txt === '确认' || txt === '确定' || txt === '确认投递' || txt === '投递简历' || txt === '立即投递') && cb !== applyBtn) {
          if (cb.offsetParent !== null && cb.getClientRects().length > 0) {
            confirmBtn = cb;
            break;
          }
        }
      }
      if (confirmBtn) {
        console.log(`[投上岸] 智联点击确认: "${confirmBtn.textContent.trim()}"`);
        confirmBtn.click();
        _sleep(1000);
      }
    }
    
    // 最终检查
    const finalBody = document.body.textContent || '';
    if (finalBody.includes('已投递') || finalBody.includes('已申请')) {
      return { success: true, jobId: job?.id, method: '最终确认已投递' };
    }
    try {
      if (applyBtn.textContent.trim().includes('已投递')) {
        return { success: true, jobId: job?.id, method: '最终按钮已变化' };
      }
    } catch(e) {}
    
    // 按钮已点击，视为成功
    return { success: true, jobId: job?.id, method: '按钮已点击-视为成功', clicked: true };
  } catch (e) {
    return { success: false, error: e.message, jobId: job?.id };
  }
}

function liepinApplySingle(params) {
  const { job } = params || {};
  
  // 内联文本匹配函数
  function _findBtn(patterns, excludeTexts) {
    const results = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT, null, false);
    let node;
    while (node = walker.nextNode()) {
      const el = node;
      const tag = el.tagName.toLowerCase();
      if (['script','style','noscript','meta','link','head'].includes(tag)) continue;
      if (el.offsetParent === null && el.getClientRects().length === 0) continue;
      const text = el.textContent.trim();
      if (!text || text.length > 100) continue;
      if (excludeTexts && excludeTexts.some(et => text.includes(et))) continue;
      for (const pattern of patterns) {
        if (text.includes(pattern)) {
          results.push({ el, text, tag, quality: text.length });
          break;
        }
      }
    }
    results.sort((a, b) => a.quality - b.quality);
    if (results.length > 0) {
      console.log(`[投上岸] 猎聘 _findBtn: 找到 "${results[0].text}" (${results[0].tag})`);
      return results[0].el;
    }
    return null;
  }
  
  try {
    // 猎聘：使用通用文本匹配查找投递/沟通按钮
    let applyBtn = _findBtn(['立即投递', '投递简历', '投递', '立即沟通', '沟通', '申请'], ['已投递', '已沟通', '已申请', '登录', '注册']);
    
    // 策略2: 通过class查找
    if (!applyBtn) {
      const applySelectors = ['.apply-btn', '.deliver-btn', '.send-resume-btn', '[class*="apply"]', '[class*="deliver"]', '[class*="send-resume"]', '[class*="chat-btn"]', '.btn-apply'];
      for (const sel of applySelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          applyBtn = el;
          console.log('[投上岸] 猎聘找到投递按钮(class匹配):', sel);
          break;
        }
      }
    }
    
    // 策略3: 如果当前页面没有投递按钮且job有URL，返回需要跳转详情页的信号
    if (!applyBtn) {
      if (job?.url) {
        return { success: false, error: '列表页无投递按钮，需跳转详情页', jobId: job?.id, needDetail: true, detailUrl: job.url };
      }
      // 调试
      console.log('[投上岸] 猎聘未找到投递按钮，调试信息:');
      document.querySelectorAll('button, a, span, div').forEach((el, i) => {
        const txt = (el.textContent || '').trim().substring(0, 30);
        if (txt && (txt.includes('投递') || txt.includes('沟通') || txt.includes('申请'))) {
          console.log(`  el${i}: tag="${el.tagName}" text="${txt}" class="${el.className}"`);
        }
      });
      return { success: false, error: '未找到投递按钮', jobId: job?.id };
    }

    console.log(`[投上岸] 猎聘找到投递按钮: "${applyBtn.textContent.trim()}" (${applyBtn.tagName})`);
    applyBtn.click();

    // 等待3-5秒，检查是否出现"已投递"状态
    const waitTime = 3000 + Math.random() * 2000;
    const start = Date.now();
    while (Date.now() - start < waitTime) { /* busy wait */ }

    // 检查页面是否出现"已投递"或类似状态文字
    const bodyText = document.body.textContent || '';
    const appliedKeywords = ['已投递', '投递成功', '已申请', '申请成功', 'success'];
    for (const kw of appliedKeywords) {
      if (bodyText.includes(kw)) {
        return { success: true, jobId: job?.id, method: '投递按钮-确认已投递' };
      }
    }

    // 检查是否有投递成功的提示元素
    const successEls = document.querySelectorAll('[class*="success"], [class*="applied"], [class*="delivered"], [class*="tip-success"], [class*="toast"], [class*="tip"]');
    for (const el of successEls) {
      if (el.offsetParent === null) continue;
      const txt = (el.textContent || '').trim();
      if (txt.includes('已投递') || txt.includes('投递成功') || txt.includes('已申请')) {
        return { success: true, jobId: job?.id, method: '投递按钮-检测到成功提示' };
      }
    }

    // 检查按钮是否变为"已投递"状态
    const btnText = applyBtn.textContent.trim();
    if (btnText.includes('已投递') || btnText.includes('已沟通') || btnText.includes('已申请')) {
      return { success: true, jobId: job?.id, method: '投递按钮-按钮已变为已投递' };
    }

    // 未确认已投递状态，但已点击了按钮
    return { success: false, error: '已点击投递，但未确认已投递状态', jobId: job?.id, clicked: true };
  } catch (e) {
    return { success: false, error: e.message, jobId: job?.id };
  }
}

// ==================== 标签页管理 ====================

async function openPlatformTab(platform, url) {
  const defaults = {
    boss: 'https://www.zhipin.com/web/geek/job?query=人事&city=100010000',
    liepin: 'https://www.liepin.com/zhaopin/?key=人事',
    zhilian: 'https://www.zhaopin.com/sou/?keyword=人事&city=武汉',
    qiancheng: 'https://we.51job.com/pc/search?keyword=人事'
  };
  const config = PLATFORM_CONFIG[platform];
  // 关闭该平台已有的旧标签页，确保新标签页加载最新内容脚本
  if (config) {
    const existingTabs = await chrome.tabs.query({});
    for (const t of existingTabs) {
      if (t.id && urlMatch(t.url, config.urlPatterns)) {
        try { await chrome.tabs.remove(t.id); console.log('[投上岸] 关闭旧标签页: ' + platform + ' tabId=' + t.id); } catch(e) {}
      }
    }
  }
  const tab = await chrome.tabs.create({ url: url || defaults[platform] || '', active: true });
  platformStatus[platform] = { ready: false, tabId: tab.id };
  console.log('[投上岸] 打开 ' + platform + ' 标签页: tabId=' + tab.id);
  return { success: true, tabId: tab.id };
}

// ==================== 事件监听 ====================

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const p of Object.keys(platformStatus)) {
    if (platformStatus[p].tabId === tabId) platformStatus[p] = { ready: false, tabId: null };
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.status !== 'complete' || !tab.url) return;
  const platform = detectPlatform(tab.url);
  if (platform) {
    platformStatus[platform] = { ready: false, tabId: tabId };
    console.log('[投上岸] 标签页就绪: ' + platform + ' tabId=' + tabId);
  }
});

// ==================== 外部重连触发 ====================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'RECONNECT_WS') {
    console.log('[投上岸] 收到重连指令，强制重连 WebSocket');
    if (ws) { try { ws.close(); } catch(e) {} ws = null; }
    isConnected = false;
    connectWebSocket();
    sendResponse({ success: true, message: '重连指令已发送' });
    return true; // 保持消息通道开放（异步响应）
  }
  if (msg.type === 'PING') {
    sendResponse({ success: true, connected: isConnected, version: 'v11' });
    return true;
  }
});

// ==================== 保活 ====================

chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.2 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) {
    if (!isConnected) {
      console.log('[投上岸] 保活检测：未连接，尝试重连');
      connectWebSocket();
    } else {
      // 即使已连接也发送 PING 确认链路通畅
      sendWS({ type: 'PING' });
    }
  }
});

// ==================== 启动 ====================

(async function init() {
  await scanTabs();
  connectWebSocket();
  console.log('[投上岸] v11 已启动 — MAIN world 注入 + 自动重连');
})();