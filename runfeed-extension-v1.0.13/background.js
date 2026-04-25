// Runfeed Background Service Worker

const VERSION = chrome.runtime.getManifest().version;
const TOKEN_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const TOKEN_CACHE_STORAGE_KEY = "runfeed_token_cache";

// Token cache
const tokenCache = new Map();
const pendingTokenRequests = new Map();

// ─── Group Debug Log (circular buffer, last 50 entries) ───
const GROUP_DEBUG_LOG_MAX = 50;
let groupDebugLog = [];

function addGroupDebugEntry(entry) {
  groupDebugLog.push({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (groupDebugLog.length > GROUP_DEBUG_LOG_MAX) {
    groupDebugLog = groupDebugLog.slice(-GROUP_DEBUG_LOG_MAX);
  }
}

function getGroupDebugLog() {
  return [...groupDebugLog];
}

function isTokenCacheEntryFresh(entry) {
  return (
    !!entry &&
    typeof entry.token === "string" &&
    entry.token.length > 0 &&
    typeof entry.time === "number" &&
    Date.now() - entry.time < TOKEN_CACHE_TTL
  );
}

async function readPersistedTokenCache() {
  const stored = await chrome.storage.local.get(TOKEN_CACHE_STORAGE_KEY);
  const cache = stored[TOKEN_CACHE_STORAGE_KEY];

  if (!cache || typeof cache !== "object") {
    return {};
  }

  return cache;
}

async function persistTokenCacheEntry(accountId, token) {
  const entry = { token, time: Date.now() };
  tokenCache.set(accountId, entry);

  const cache = await readPersistedTokenCache();
  cache[accountId] = entry;
  await chrome.storage.local.set({ [TOKEN_CACHE_STORAGE_KEY]: cache });
}

async function clearPersistedTokenCacheEntry(accountId) {
  tokenCache.delete(accountId);

  const cache = await readPersistedTokenCache();
  if (cache[accountId]) {
    delete cache[accountId];
    await chrome.storage.local.set({ [TOKEN_CACHE_STORAGE_KEY]: cache });
  }
}

async function getPersistedToken(accountId) {
  const cache = await readPersistedTokenCache();
  const entry = cache[accountId];

  if (isTokenCacheEntryFresh(entry)) {
    tokenCache.set(accountId, entry);
    return entry.token;
  }

  if (entry) {
    delete cache[accountId];
    await chrome.storage.local.set({ [TOKEN_CACHE_STORAGE_KEY]: cache });
  }

  return null;
}

// ─── Cookie Helpers ───

async function getFacebookCookies() {
  const cookies = await chrome.cookies.getAll({ domain: ".facebook.com" });
  return cookies;
}

async function getAccountsFromCookies() {
  const cookies = await getFacebookCookies();
  const cUserCookies = cookies.filter((c) => c.name === "c_user");

  return cUserCookies.map((c) => ({
    id: c.value,
    cookieValue: c.value,
  }));
}

async function getCookieString(accountId) {
  const cookies = await getFacebookCookies();
  return cookies
    .filter((c) => {
      if (c.name === "c_user") return c.value === accountId;
      return true;
    })
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

// ─── Dynamic Net Request Rules ───

function addAccountMarker(url, accountId) {
  if (!accountId) return url;

  const nextUrl = new URL(url);
  nextUrl.searchParams.set("app_fb_id", accountId);
  return nextUrl.toString();
}

async function setupDynamicRules(accountId) {
  if (!accountId) return;

  const cookieString = await getCookieString(accountId);
  const ruleId = 1001;
  const graphRuleId = 2001;

  const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existingRules
    .filter((rule) => rule.id === ruleId || rule.id === graphRuleId)
    .map((rule) => rule.id);

  const addRules = [
    {
      id: ruleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Cookie", operation: "set", value: cookieString },
        ],
      },
      condition: {
        urlFilter: `*facebook.com/*app_fb_id=${accountId}*`,
        resourceTypes: ["xmlhttprequest"],
      },
    },
    {
      id: graphRuleId,
      priority: 2,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "Cookie", operation: "set", value: cookieString },
        ],
      },
      condition: {
        urlFilter: `*graph.facebook.com/*app_fb_id=${accountId}*`,
        resourceTypes: ["xmlhttprequest"],
      },
    },
  ];

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules,
  });

  await chrome.storage.local.set({ activeAccountId: accountId });
}

function stripForLoopPrefix(text) {
  return text.replace(/^for\s*\(;;\)\s*;\s*/, "").trim();
}

async function parseJsonLikeResponse(response) {
  const text = await response.text();
  const normalized = stripForLoopPrefix(text);

  if (!normalized) {
    return { data: null, raw: text };
  }

  try {
    return { data: JSON.parse(normalized), raw: text };
  } catch {
    return { data: null, raw: text };
  }
}

function base64ToBlob(base64, mimeType = "image/jpeg") {
  const byteChars = atob(base64);
  const byteArrays = new Uint8Array(byteChars.length);

  for (let i = 0; i < byteChars.length; i += 1) {
    byteArrays[i] = byteChars.charCodeAt(i);
  }

  return new Blob([byteArrays], { type: mimeType });
}

// ─── Token Extraction ───

function extractTokenFromHTML(html) {
  const patterns = [
    /["'](EAAG[A-Za-z0-9]+)["']/,
    /["'](EAA[A-Za-z0-9]{20,})["']/,
    /accessToken["']\s*[:=]\s*["'](EAA[A-Za-z0-9]+)["']/,
    /access_token=(EAA[A-Za-z0-9]+)/,
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function extractTokenFromTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.innerHTML,
    });
    if (results?.[0]?.result) {
      return extractTokenFromHTML(results[0].result);
    }
  } catch {
    // Tab may not be accessible
  }
  return null;
}

async function getToken(accountId, forceRefresh = false) {
  if (pendingTokenRequests.has(accountId)) {
    return pendingTokenRequests.get(accountId);
  }

  const tokenRequest = (async () => {
    if (forceRefresh) {
      await clearPersistedTokenCacheEntry(accountId);
    }

    // Check in-memory cache
    if (!forceRefresh && tokenCache.has(accountId)) {
      const cached = tokenCache.get(accountId);
      if (isTokenCacheEntryFresh(cached)) {
        return cached.token;
      }
      tokenCache.delete(accountId);
    }

    // Check persisted cache so service worker restarts do not force a new Ads Manager tab
    if (!forceRefresh) {
      const persistedToken = await getPersistedToken(accountId);
      if (persistedToken) {
        return persistedToken;
      }
    }

    // Try existing Facebook tabs
    const fbTabs = await chrome.tabs.query({
      url: [
        "*://*.facebook.com/*",
        "*://business.facebook.com/*",
        "*://adsmanager.facebook.com/*",
      ],
    });

    for (const tab of fbTabs) {
      const token = await extractTokenFromTab(tab.id);
      if (token) {
        await persistTokenCacheEntry(accountId, token);
        return token;
      }
    }

    // Fallback: open background tabs for a few known Facebook surfaces
    const targetUrls = [
      "https://adsmanager.facebook.com/adsmanager/manage/campaigns",
      "https://www.facebook.com/adsmanager/manage/campaigns",
      "https://www.facebook.com/pages/?category=your_pages&ref=bookmarks",
    ];

    for (const targetUrl of targetUrls) {
      const token = await new Promise((resolve) => {
        const tab = chrome.tabs.create({
          url: targetUrl,
          active: false,
        });

        tab.then((newTab) => {
          const timeout = setTimeout(() => {
            chrome.tabs.remove(newTab.id).catch(() => {});
            resolve(null);
          }, 12000);

          const listener = async (tabId, changeInfo) => {
            if (tabId !== newTab.id || changeInfo.status !== "complete") return;

            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timeout);

            // Give page scripts a moment to populate token-bearing HTML
            await new Promise((r) => setTimeout(r, 2000));

            const resolvedToken = await extractTokenFromTab(newTab.id);
            chrome.tabs.remove(newTab.id).catch(() => {});

            if (resolvedToken) {
              await persistTokenCacheEntry(accountId, resolvedToken);
            }
            resolve(resolvedToken);
          };

          chrome.tabs.onUpdated.addListener(listener);
        });
      });

      if (token) {
        return token;
      }
    }

    return null;
  })();

  pendingTokenRequests.set(accountId, tokenRequest);

  try {
    return await tokenRequest;
  } finally {
    pendingTokenRequests.delete(accountId);
  }
}

// ─── CSRF Token Extraction (fb_dtsg) ───

async function getFbDtsg() {
  const fbTabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });

  for (const tab of fbTabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.documentElement.innerHTML,
      });

      const html = results?.[0]?.result;
      if (!html) continue;

      const patterns = [
        /"DTSGInitData".*?"token"\s*:\s*"([^"]+)"/,
        /"DTSGInitData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/,
        /"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/,
        /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/,
        /\["LSD",\[\],\{"token":"([^"]+)"/,
        /name="fb_dtsg"\s+value="([^"]+)"/,
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          // Also extract LSD token
          const lsdMatch = html.match(
            /\["LSD",\[\],\{"token":"([^"]+)"/
          );
          return {
            fbDtsg: match[1],
            lsd: lsdMatch ? lsdMatch[1] : null,
          };
        }
      }
    } catch {
      continue;
    }
  }

  return { fbDtsg: null, lsd: null, error: "ไม่พบ fb_dtsg — เปิด Facebook ในบราวเซอร์" };
}

// ─── Group-specific CSRF Token Extraction (isolated from page tools) ───

const GROUP_TOKEN_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let groupTokenCache = null; // { fbDtsg, lsd, accountId, extractedAt }

async function getFbDtsgForGroup(accountId, forceRefresh = false) {
  // Return cached token if still fresh and same account
  if (
    !forceRefresh &&
    groupTokenCache &&
    groupTokenCache.accountId === accountId &&
    groupTokenCache.fbDtsg &&
    Date.now() - groupTokenCache.extractedAt < GROUP_TOKEN_CACHE_TTL
  ) {
    return { fbDtsg: groupTokenCache.fbDtsg, lsd: groupTokenCache.lsd };
  }

  const fbTabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
  if (fbTabs.length === 0) {
    return { fbDtsg: null, lsd: null, error: "ไม่พบแท็บ Facebook — เปิด Facebook ในบราวเซอร์" };
  }

  // Strategy 1: MAIN-world extraction via Facebook module system (most stable)
  for (const tab of fbTabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: () => {
          let fbDtsg = null;
          let lsd = null;

          // Try Facebook's internal module system
          try {
            const dtsgMod =
              (typeof require === "function" && require("DTSGInitData")) ||
              (typeof __d === "function" && __d("DTSGInitData"));
            if (dtsgMod?.token) fbDtsg = dtsgMod.token;
          } catch {}

          // Try known global variables
          if (!fbDtsg) {
            try {
              if (window.__comet_infra_fb_dtsg) fbDtsg = window.__comet_infra_fb_dtsg;
            } catch {}
          }

          // Try DOM input element
          if (!fbDtsg) {
            try {
              const el = document.querySelector('input[name="fb_dtsg"]');
              if (el?.value) fbDtsg = el.value;
            } catch {}
          }

          // Try LSD from module system
          try {
            const lsdMod =
              (typeof require === "function" && require("LSD")) ||
              (typeof __d === "function" && __d("LSD"));
            if (lsdMod?.token) lsd = lsdMod.token;
          } catch {}

          // Try LSD from DOM
          if (!lsd) {
            try {
              const el = document.querySelector('input[name="lsd"]');
              if (el?.value) lsd = el.value;
            } catch {}
          }

          return { fbDtsg, lsd };
        },
      });

      const result = results?.[0]?.result;
      if (result?.fbDtsg) {
        groupTokenCache = {
          fbDtsg: result.fbDtsg,
          lsd: result.lsd,
          accountId,
          extractedAt: Date.now(),
        };
        return { fbDtsg: result.fbDtsg, lsd: result.lsd };
      }
    } catch {
      continue;
    }
  }

  // Strategy 2: HTML regex fallback (same approach as getFbDtsg but isolated)
  for (const tab of fbTabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => document.documentElement.innerHTML,
      });

      const html = results?.[0]?.result;
      if (!html) continue;

      const patterns = [
        /"DTSGInitData".*?"token"\s*:\s*"([^"]+)"/,
        /"DTSGInitData"\s*,\s*\[\]\s*,\s*\{"token"\s*:\s*"([^"]+)"/,
        /"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/,
        /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/,
        /name="fb_dtsg"\s+value="([^"]+)"/,
      ];

      for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) {
          const lsdMatch = html.match(/\["LSD",\[\],\{"token":"([^"]+)"/);
          const token = {
            fbDtsg: match[1],
            lsd: lsdMatch ? lsdMatch[1] : null,
          };
          groupTokenCache = {
            ...token,
            accountId,
            extractedAt: Date.now(),
          };
          return token;
        }
      }
    } catch {
      continue;
    }
  }

  return { fbDtsg: null, lsd: null, error: "ไม่พบ fb_dtsg — เปิด Facebook ในบราวเซอร์แล้วลอง refresh" };
}

function invalidateGroupTokenCache() {
  groupTokenCache = null;
}

// ─── Composer doc_id Auto-Discovery ───

const FALLBACK_COMPOSER_DOC_ID = "9422428464445703";
const FALLBACK_COMPOSER_FRIENDLY_NAME = "ComposerStoryCreateMutation";
const SHARE_DIALOG_QUERY_DOC_ID = "8794502700648748";

let composerDocIdCache = null;
const COMPOSER_DOC_ID_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Mutation names we look for when scraping Facebook JS bundles
const COMPOSER_MUTATION_NAMES = [
  "ComposerStoryCreateMutation",
  "useGroupsCometGroupDiscussionCreatePostMutation",
  "useCometFeedStoryCreateMutation",
  "GroupsCometGroupDiscussionCreatePostMutation",
  "CometGroupDiscussionCreatePostMutation",
];

async function discoverComposerDocId(accountId, forceRefresh = false) {
  // Return cached result if fresh
  if (
    !forceRefresh &&
    composerDocIdCache &&
    composerDocIdCache.docId &&
    Date.now() - composerDocIdCache.discoveredAt < COMPOSER_DOC_ID_CACHE_TTL
  ) {
    return { docId: composerDocIdCache.docId, friendlyName: composerDocIdCache.friendlyName };
  }

  const fbTabs = await chrome.tabs.query({ url: "*://*.facebook.com/*" });
  if (fbTabs.length === 0) {
    return { docId: null, error: "ไม่พบแท็บ Facebook — เปิด Facebook ในบราวเซอร์" };
  }

  // Prefer group tabs first (more likely to have composer JS loaded)
  const sortedTabs = [...fbTabs].sort((a, b) => {
    const aGroup = (a.url || "").includes("/groups/") ? 0 : 1;
    const bGroup = (b.url || "").includes("/groups/") ? 0 : 1;
    return aGroup - bGroup;
  });

  // Strategy 1: MAIN-world — try Facebook's require() module system + scan individual script tags
  for (const tab of sortedTabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: (mutationNames) => {
          // 1a. Try Facebook's require() module system
          for (const name of mutationNames) {
            const variants = [
              `${name}$parameters`,
              `${name}_facebookRelayOperation$parameters`,
              name,
            ];
            for (const modName of variants) {
              try {
                const mod = typeof require === "function" ? require(modName) : null;
                if (!mod) continue;

                // Module could be: { id: "..." } or { params: { id: "..." } } or have nested structure
                if (mod.id && /^\d{10,}$/.test(String(mod.id))) {
                  return { docId: String(mod.id), friendlyName: name, source: "require" };
                }
                if (mod.params?.id && /^\d{10,}$/.test(String(mod.params.id))) {
                  return { docId: String(mod.params.id), friendlyName: name, source: "require" };
                }
                // Relay Modern PreloadableConcreteRequest format
                if (mod.params?.params?.id && /^\d{10,}$/.test(String(mod.params.params.id))) {
                  return { docId: String(mod.params.params.id), friendlyName: name, source: "require" };
                }
              } catch {}
            }
          }

          // 1b. Scan individual inline <script> tags (more targeted than innerHTML)
          const scripts = document.querySelectorAll("script:not([src])");
          for (const script of scripts) {
            const text = script.textContent || "";
            if (text.length < 100) continue;

            for (const name of mutationNames) {
              if (!text.includes(name)) continue;

              // Facebook __d module definition: __d("Name$parameters",[...],function(...){e.exports={...,id:"12345",...}})
              // Or relay format: {id:"12345",...,name:"MutationName",...,operationKind:"mutation"}
              const patterns = [
                // __d definition with id in params
                new RegExp(`"${name}[^"]*"[\\s\\S]{0,1000}?"id"\\s*:\\s*"(\\d{10,})"`, ""),
                // Relay operation format: name then id (allow more chars between)
                new RegExp(`"${name}"[\\s\\S]{0,2000}?"id"\\s*:\\s*"(\\d{10,})"`, ""),
                // Reversed: id before name
                new RegExp(`"id"\\s*:\\s*"(\\d{10,})"[\\s\\S]{0,2000}?"${name}"`, ""),
                // Compact minified format: name:"MutationName",id:"12345"
                new RegExp(`name:"${name}"[\\s\\S]{0,500}?id:"(\\d{10,})"`, ""),
                new RegExp(`id:"(\\d{10,})"[\\s\\S]{0,500}?name:"${name}"`, ""),
              ];

              for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match?.[1]) {
                  return { docId: match[1], friendlyName: name, source: "inline_script" };
                }
              }
            }
          }

          // 1c. Collect external JS bundle URLs for Strategy 2
          const externalUrls = [];
          // From script tags
          for (const s of document.querySelectorAll("script[src]")) {
            if (s.src && /\.js(\?|$)/.test(s.src)) externalUrls.push(s.src);
          }
          // From performance API (catches dynamically loaded bundles)
          try {
            for (const entry of performance.getEntriesByType("resource")) {
              if (entry.initiatorType === "script" && /\.js(\?|$)/.test(entry.name)) {
                if (!externalUrls.includes(entry.name)) externalUrls.push(entry.name);
              }
            }
          } catch {}

          return { docId: null, bundleUrls: externalUrls.slice(0, 30) };
        },
        args: [COMPOSER_MUTATION_NAMES],
      });

      const result = results?.[0]?.result;
      if (result?.docId) {
        composerDocIdCache = {
          docId: result.docId,
          friendlyName: result.friendlyName,
          discoveredAt: Date.now(),
        };
        return { docId: result.docId, friendlyName: result.friendlyName };
      }

      // Strategy 2: Fetch external JS bundles from the background service worker
      const bundleUrls = result?.bundleUrls;
      if (Array.isArray(bundleUrls) && bundleUrls.length > 0) {
        for (const bundleUrl of bundleUrls) {
          try {
            const res = await fetch(bundleUrl, { credentials: "omit" });
            if (!res.ok) continue;
            const text = await res.text();

            for (const name of COMPOSER_MUTATION_NAMES) {
              if (!text.includes(name)) continue;

              const patterns = [
                new RegExp(`"${name}[^"]*"[\\s\\S]{0,1000}?"id"\\s*:\\s*"(\\d{10,})"`, ""),
                new RegExp(`"${name}"[\\s\\S]{0,2000}?"id"\\s*:\\s*"(\\d{10,})"`, ""),
                new RegExp(`"id"\\s*:\\s*"(\\d{10,})"[\\s\\S]{0,2000}?"${name}"`, ""),
                new RegExp(`name:"${name}"[\\s\\S]{0,500}?id:"(\\d{10,})"`, ""),
                new RegExp(`id:"(\\d{10,})"[\\s\\S]{0,500}?name:"${name}"`, ""),
              ];

              for (const pattern of patterns) {
                const match = text.match(pattern);
                if (match?.[1]) {
                  composerDocIdCache = {
                    docId: match[1],
                    friendlyName: name,
                    discoveredAt: Date.now(),
                  };
                  return { docId: match[1], friendlyName: name };
                }
              }
            }
          } catch {
            continue;
          }
        }
      }
    } catch {
      continue;
    }
  }

  // Strategy 3: Use hardcoded fallback doc_id
  composerDocIdCache = {
    docId: FALLBACK_COMPOSER_DOC_ID,
    friendlyName: FALLBACK_COMPOSER_FRIENDLY_NAME,
    discoveredAt: Date.now(),
  };
  return { docId: FALLBACK_COMPOSER_DOC_ID, friendlyName: FALLBACK_COMPOSER_FRIENDLY_NAME };
}

function invalidateComposerDocIdCache() {
  composerDocIdCache = null;
}

// ─── Hide Post (GraphQL in MAIN world) ───

function getHideTabPriority(url = "") {
  if (url.includes("www.facebook.com/pages")) return 0;
  if (url.includes("www.facebook.com")) return 1;
  if (url.includes("facebook.com")) return 2;
  if (url.includes("business.facebook.com")) return 3;
  if (url.includes("adsmanager.facebook.com")) return 4;
  return 5;
}

async function waitForTabComplete(tabId, timeoutMs = 15000) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.status === "complete") {
    return true;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(false);
    }, timeoutMs);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete") {
        return;
      }

      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(true);
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

function computeJazoest(fbDtsg) {
  let total = 0;
  for (let index = 0; index < fbDtsg.length; index += 1) {
    total += fbDtsg.charCodeAt(index);
  }
  return `2${total}`;
}

function tryParseJsonLikeString(text) {
  if (typeof text !== "string") {
    return null;
  }

  const normalized = stripForLoopPrefix(text).trim();
  if (!normalized) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    return null;
  }
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function looksLikeBase64(value) {
  return (
    typeof value === "string" &&
    value.length >= 12 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/=]+$/.test(value)
  );
}

function safeDecodeBase64(value) {
  try {
    return atob(value);
  } catch {
    return null;
  }
}

function safeEncodeBase64(value) {
  try {
    return btoa(value);
  } catch {
    return null;
  }
}

function replaceGroupDeleteMarkers(value, replacements) {
  return String(value)
    .split("{{POST_ID}}")
    .join(replacements.postId)
    .split("{{GROUP_ID}}")
    .join(replacements.groupId)
    .split("{{ACCOUNT_ID}}")
    .join(replacements.accountId);
}

function hydrateGroupDeleteTemplateNode(value, replacements) {
  if (typeof value === "string") {
    const parsedJson = tryParseJsonLikeString(value);
    if (parsedJson && /^[\[{]/.test(value.trim())) {
      return JSON.stringify(
        hydrateGroupDeleteTemplateNode(parsedJson, replacements)
      );
    }

    const replaced = replaceGroupDeleteMarkers(value, replacements);
    if (looksLikeBase64(replaced)) {
      const decoded = safeDecodeBase64(replaced);
      if (decoded && decoded.includes("{{")) {
        return safeEncodeBase64(
          replaceGroupDeleteMarkers(decoded, replacements)
        ) || replaced;
      }
    }

    return replaced;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      hydrateGroupDeleteTemplateNode(item, replacements)
    );
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        hydrateGroupDeleteTemplateNode(nested, replacements),
      ])
    );
  }

  return value;
}

function getValueAtPath(value, path) {
  if (!path) {
    return undefined;
  }

  return path.split(".").reduce((current, segment) => {
    if (current == null) {
      return undefined;
    }

    const normalizedSegment = /^\d+$/.test(segment)
      ? Number(segment)
      : segment;
    return current[normalizedSegment];
  }, value);
}

function responseHasErrors(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value.error ||
        (Array.isArray(value.errors) && value.errors.length > 0) ||
        value.exception)
  );
}

function responseMatchesSuccessTemplate(value, successPaths = []) {
  if (!value || successPaths.length === 0) {
    return false;
  }

  return successPaths.some((path) => getValueAtPath(value, path) === true);
}

function responseMatchesTruthyTemplate(value, successPaths = []) {
  if (!value) return false;

  // Primary: check captured success paths
  if (successPaths.length > 0) {
    const pathMatch = successPaths.some((path) => {
      const candidate = getValueAtPath(value, path);
      if (candidate === true) return true;
      if (typeof candidate === "number") return Number.isFinite(candidate);
      return typeof candidate === "string" && candidate.trim().length > 0;
    });
    if (pathMatch) return true;
  }

  // Fallback: look for common success signals in the response
  const str = JSON.stringify(value);

  // Post/story ID in response (15+ digit numeric string) is a strong signal
  if (/"\d{15,}"/.test(str)) return true;

  // Empty errors array with data present = success
  if (value.data && Array.isArray(value.errors) && value.errors.length === 0) return true;

  // Response has "data" key with nested content and no errors = likely success
  if (value.data && typeof value.data === "object" && !value.error && !value.errors) {
    const dataStr = JSON.stringify(value.data);
    // Contains permalink or URL = post was created
    if (/permalink|url.*facebook/i.test(dataStr)) return true;
  }

  return false;
}

function getFacebookTabPriority(url = "", active = false) {
  if (active) return -1;
  if (url.includes("/groups/")) return 0;
  if (url.includes("www.facebook.com")) return 1;
  if (url.includes("facebook.com")) return 2;
  return 5;
}

async function getPreferredFacebookTab() {
  const tabs = await chrome.tabs.query({
    url: ["*://*.facebook.com/*"],
    currentWindow: true,
  });

  if (tabs.length === 0) {
    return null;
  }

  return [...tabs].sort(
    (left, right) =>
      getFacebookTabPriority(left.url, left.active) -
      getFacebookTabPriority(right.url, right.active)
  )[0];
}

function replaceGroupShareMarkers(value, replacements) {
  return String(value)
    .split("{{MESSAGE}}")
    .join(replacements.message)
    .split("{{LINK}}")
    .join(replacements.link)
    .split("{{GROUP_ID}}")
    .join(replacements.groupId)
    .split("{{ACCOUNT_ID}}")
    .join(replacements.accountId);
}

function hydrateGroupShareTemplateNode(value, replacements) {
  if (typeof value === "string") {
    const parsedJson = tryParseJsonLikeString(value);
    if (parsedJson && /^[\[{]/.test(value.trim())) {
      return JSON.stringify(
        hydrateGroupShareTemplateNode(parsedJson, replacements)
      );
    }

    const replaced = replaceGroupShareMarkers(value, replacements);
    if (looksLikeBase64(replaced)) {
      const decoded = safeDecodeBase64(replaced);
      if (decoded && decoded.includes("{{")) {
        return (
          safeEncodeBase64(
            replaceGroupShareMarkers(decoded, replacements)
          ) || replaced
        );
      }
    }

    return replaced;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      hydrateGroupShareTemplateNode(item, replacements)
    );
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        hydrateGroupShareTemplateNode(nested, replacements),
      ])
    );
  }

  return value;
}

async function captureGroupDeleteRequest(
  postId,
  groupId,
  accountId,
  timeoutMs = 90000
) {
  const targetTab = await getPreferredFacebookTab();
  if (!targetTab?.id) {
    return {
      success: false,
      error: "NO_FACEBOOK_TAB",
      message: "ไม่พบแท็บ Facebook ที่เปิดอยู่สำหรับจับ request",
    };
  }

  const loaded = await waitForTabComplete(targetTab.id, 15000);
  if (!loaded) {
    return {
      success: false,
      error: "TAB_LOAD_TIMEOUT",
      message: "แท็บ Facebook ยังโหลดไม่เสร็จ ลองรอให้หน้าโหลดครบก่อน",
    };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    world: "MAIN",
    func: async (expectedPostId, expectedGroupId, expectedAccountId, waitMs) => {
      const sleep = (ms) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const safeText = async (value) => {
        try {
          if (!value) return "";
          if (typeof value === "string") return value;
          if (value instanceof URLSearchParams) return value.toString();
          if (value instanceof FormData) {
            const params = new URLSearchParams();
            for (const [key, entry] of value.entries()) {
              params.append(key, typeof entry === "string" ? entry : "[binary]");
            }
            return params.toString();
          }
          if (value instanceof Request) return await value.clone().text();
          if (value instanceof Blob) return "[binary]";
          if (typeof value === "object") return JSON.stringify(value);
          return String(value);
        } catch {
          return "";
        }
      };
      const headersToObject = (headers) => {
        try {
          if (!headers) return {};
          if (headers instanceof Headers) {
            return Object.fromEntries(headers.entries());
          }
          if (Array.isArray(headers)) {
            return Object.fromEntries(headers);
          }
          if (typeof headers === "object") {
            return Object.fromEntries(
              Object.entries(headers).map(([key, value]) => [key, String(value)])
            );
          }
          return {};
        } catch {
          return {};
        }
      };
      const restoreCandidates = [];
      const cUserMatch = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
      const activeAccountId = cUserMatch ? cUserMatch[1] : null;

      if (expectedAccountId && activeAccountId && activeAccountId !== expectedAccountId) {
        return {
          success: false,
          error: "ACTIVE_ACCOUNT_MISMATCH",
          message: `บัญชี Facebook ในแท็บนี้คือ ${activeAccountId} ไม่ตรงกับ ${expectedAccountId}`,
          activeAccountId,
        };
      }

      const maybeMatchDeleteRequest = (url, method, body, responseText) => {
        if (String(method || "GET").toUpperCase() !== "POST") {
          return false;
        }

        const normalizedUrl = String(url || "");
        const normalizedBody = String(body || "");
        const normalizedResponse = String(responseText || "");
        const haystack = `${normalizedUrl} ${normalizedBody} ${normalizedResponse}`;
        const targetsFound =
          haystack.includes(expectedPostId) ||
          haystack.includes(expectedGroupId);
        const deleteHint =
          /delete|trash|remove|curation|moderation|deletepost|delete_story|ลบ/i.test(
            haystack
          );
        const supportedEndpoint =
          normalizedUrl.includes("/api/graphql") ||
          normalizedUrl.includes("/ajax/") ||
          normalizedUrl.includes("/api/");

        return supportedEndpoint && targetsFound && deleteHint;
      };

      return await new Promise((resolve) => {
        let settled = false;

        const finish = (payload) => {
          if (settled) return;
          settled = true;

          while (restoreCandidates.length > 0) {
            const restore = restoreCandidates.pop();
            try {
              restore();
            } catch {
              // ignore restore errors
            }
          }

          resolve(payload);
        };

        const timeout = setTimeout(() => {
          finish({
            success: false,
            error: "CAPTURE_TIMEOUT",
            message: "ยังไม่พบ request ลบโพสต์ในเวลาที่กำหนด",
            activeAccountId,
          });
        }, waitMs);
        restoreCandidates.push(() => clearTimeout(timeout));

        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const [input, init] = args;
          const request =
            input instanceof Request ? input.clone() : null;
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : request?.url || "";
          const method =
            init?.method || request?.method || "GET";
          const body = await safeText(init?.body ?? request ?? "");
          const headers = headersToObject(init?.headers || request?.headers);
          const response = await originalFetch(...args);
          const responseText = await response.clone().text().catch(() => "");

          if (maybeMatchDeleteRequest(url, method, body, responseText)) {
            finish({
              success: true,
              capture: {
                url,
                method,
                body,
                headers,
                status: response.status,
                responseText,
              },
              activeAccountId,
            });
          }

          return response;
        };
        restoreCandidates.push(() => {
          window.fetch = originalFetch;
        });

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

        XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
          this.__runfeedCapture = {
            method,
            url,
            headers: {},
          };
          return originalOpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(
          key,
          value
        ) {
          if (this.__runfeedCapture) {
            this.__runfeedCapture.headers[key] = value;
          }
          return originalSetHeader.call(this, key, value);
        };

        XMLHttpRequest.prototype.send = function patchedSend(body) {
          const requestInfo = this.__runfeedCapture || {
            method: "GET",
            url: "",
            headers: {},
          };

          const finalize = async () => {
            await sleep(0);
            const bodyText = await safeText(body);
            const responseText = this.responseText || "";

            if (
              maybeMatchDeleteRequest(
                requestInfo.url,
                requestInfo.method,
                bodyText,
                responseText
              )
            ) {
              finish({
                success: true,
                capture: {
                  url: requestInfo.url,
                  method: requestInfo.method,
                  body: bodyText,
                  headers: requestInfo.headers,
                  status: this.status,
                  responseText,
                },
                activeAccountId,
              });
            }
          };

          this.addEventListener("loadend", finalize, { once: true });
          return originalSend.call(this, body);
        };

        restoreCandidates.push(() => {
          XMLHttpRequest.prototype.open = originalOpen;
          XMLHttpRequest.prototype.send = originalSend;
          XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
        });
      });
    },
    args: [postId, groupId, accountId, timeoutMs],
  });

  return results?.[0]?.result || {
    success: false,
    error: "NO_CAPTURE_RESULT",
    message: "ไม่พบผลลัพธ์จากการจับ request",
  };
}

async function captureGroupShareRequest(
  groupId,
  accountId,
  link,
  message = "",
  timeoutMs = 90000
) {
  const targetTab = await getPreferredFacebookTab();
  if (!targetTab?.id) {
    return {
      success: false,
      error: "NO_FACEBOOK_TAB",
      message: "ไม่พบแท็บ Facebook ที่เปิดอยู่สำหรับจับ request แชร์",
    };
  }

  const loaded = await waitForTabComplete(targetTab.id, 15000);
  if (!loaded) {
    return {
      success: false,
      error: "TAB_LOAD_TIMEOUT",
      message: "แท็บ Facebook ยังโหลดไม่เสร็จ ลองรอให้หน้าโหลดครบก่อน",
    };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: targetTab.id },
    world: "MAIN",
    func: async (expectedGroupId, expectedAccountId, expectedLink, expectedMessage, waitMs) => {
      const sleep = (ms) =>
        new Promise((resolve) => setTimeout(resolve, ms));
      const safeText = async (value) => {
        try {
          if (!value) return "";
          if (typeof value === "string") return value;
          if (value instanceof URLSearchParams) return value.toString();
          if (value instanceof FormData) {
            const params = new URLSearchParams();
            for (const [key, entry] of value.entries()) {
              params.append(key, typeof entry === "string" ? entry : "[binary]");
            }
            return params.toString();
          }
          if (value instanceof Request) return await value.clone().text();
          if (value instanceof Blob) return "[binary]";
          if (typeof value === "object") return JSON.stringify(value);
          return String(value);
        } catch {
          return "";
        }
      };
      const headersToObject = (headers) => {
        try {
          if (!headers) return {};
          if (headers instanceof Headers) {
            return Object.fromEntries(headers.entries());
          }
          if (Array.isArray(headers)) {
            return Object.fromEntries(headers);
          }
          if (typeof headers === "object") {
            return Object.fromEntries(
              Object.entries(headers).map(([key, value]) => [key, String(value)])
            );
          }
          return {};
        } catch {
          return {};
        }
      };
      const restoreCandidates = [];
      const cUserMatch = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
      const activeAccountId = cUserMatch ? cUserMatch[1] : null;

      if (expectedAccountId && activeAccountId && activeAccountId !== expectedAccountId) {
        return {
          success: false,
          error: "ACTIVE_ACCOUNT_MISMATCH",
          message: `บัญชี Facebook ในแท็บนี้คือ ${activeAccountId} ไม่ตรงกับ ${expectedAccountId}`,
          activeAccountId,
        };
      }

      // Score-based request matching: higher score = better match
      const scoreShareRequest = (url, method, body, responseText) => {
        if (String(method || "GET").toUpperCase() !== "POST") return 0;

        const normalizedUrl = String(url || "");
        const normalizedBody = String(body || "");
        let score = 0;

        // Must hit a supported endpoint
        const isGraphQL = normalizedUrl.includes("/api/graphql");
        const isAjax = normalizedUrl.includes("/ajax/") || normalizedUrl.includes("/api/");
        if (!isGraphQL && !isAjax) return 0;
        if (isGraphQL) score += 2; // GraphQL is preferred

        // Must contain group ID in the body (not just anywhere)
        if (normalizedBody.includes(expectedGroupId)) score += 3;
        else return 0; // group ID is mandatory

        // Check for link in body
        if (expectedLink && normalizedBody.includes(expectedLink)) score += 3;

        // Check for message in body
        if (expectedMessage && normalizedBody.includes(expectedMessage)) score += 2;

        // Check for GraphQL mutation signals in body
        const hasDocId = normalizedBody.includes("doc_id=") || normalizedBody.includes("doc_id%");
        const hasFriendlyName = normalizedBody.includes("fb_api_req_friendly_name");
        if (hasDocId) score += 2;
        if (hasFriendlyName) score += 1;

        // Check for publish/share intent keywords in body or URL
        const haystack = `${normalizedUrl} ${normalizedBody}`;
        if (/composer|publish|create|story|feed|post|share|group.*link|link.*share|comet.*group|mutation/i.test(haystack)) {
          score += 2;
        }

        // Check variables param for structured group/link data
        try {
          const params = new URLSearchParams(normalizedBody);
          const variables = params.get("variables");
          if (variables) {
            const vars = JSON.parse(variables);
            const varsStr = JSON.stringify(vars);
            if (varsStr.includes(expectedGroupId)) score += 1;
            if (expectedLink && varsStr.includes(expectedLink)) score += 1;
          }
        } catch {}

        return score;
      };

      return await new Promise((resolve) => {
        let settled = false;
        let bestCandidate = null;
        let bestScore = 0;
        const GOOD_SCORE_THRESHOLD = 8; // Finish immediately for high-confidence matches

        const finish = (payload) => {
          if (settled) return;
          settled = true;

          while (restoreCandidates.length > 0) {
            const restore = restoreCandidates.pop();
            try {
              restore();
            } catch {
              // ignore restore errors
            }
          }

          resolve(payload);
        };

        const tryFinishWithCandidate = (captureData, score) => {
          if (settled) return;
          if (score > bestScore) {
            bestScore = score;
            bestCandidate = captureData;
          }
          // Finish immediately for high-confidence matches
          if (score >= GOOD_SCORE_THRESHOLD) {
            finish({ success: true, capture: bestCandidate, activeAccountId });
          }
        };

        const timeout = setTimeout(() => {
          // If we have a candidate when timeout fires, use it
          if (bestCandidate) {
            finish({ success: true, capture: bestCandidate, activeAccountId });
          } else {
            finish({
              success: false,
              error: "CAPTURE_TIMEOUT",
              message: "ยังไม่พบ request แชร์ลิงก์ตามเวลาที่กำหนด",
              activeAccountId,
            });
          }
        }, waitMs);
        restoreCandidates.push(() => clearTimeout(timeout));

        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const [input, init] = args;
          const request =
            input instanceof Request ? input.clone() : null;
          const url =
            typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : request?.url || "";
          const method =
            init?.method || request?.method || "GET";
          const body = await safeText(init?.body ?? request ?? "");
          const headers = headersToObject(init?.headers || request?.headers);
          const response = await originalFetch(...args);
          const responseText = await response.clone().text().catch(() => "");

          const score = scoreShareRequest(url, method, body, responseText);
          if (score > 0) {
            tryFinishWithCandidate({
              url,
              method,
              body,
              headers,
              status: response.status,
              responseText,
            }, score);
          }

          return response;
        };
        restoreCandidates.push(() => {
          window.fetch = originalFetch;
        });

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;

        XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
          this.__runfeedCapture = {
            method,
            url,
            headers: {},
          };
          return originalOpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(
          key,
          value
        ) {
          if (this.__runfeedCapture) {
            this.__runfeedCapture.headers[key] = value;
          }
          return originalSetHeader.call(this, key, value);
        };

        XMLHttpRequest.prototype.send = function patchedSend(body) {
          const requestInfo = this.__runfeedCapture || {
            method: "GET",
            url: "",
            headers: {},
          };

          const finalize = async () => {
            await sleep(0);
            const bodyText = await safeText(body);
            const responseText = this.responseText || "";

            const score = scoreShareRequest(
              requestInfo.url,
              requestInfo.method,
              bodyText,
              responseText
            );
            if (score > 0) {
              tryFinishWithCandidate({
                url: requestInfo.url,
                method: requestInfo.method,
                body: bodyText,
                headers: requestInfo.headers,
                status: this.status,
                responseText,
              }, score);
            }
          };

          this.addEventListener("loadend", finalize, { once: true });
          return originalSend.call(this, body);
        };

        restoreCandidates.push(() => {
          XMLHttpRequest.prototype.open = originalOpen;
          XMLHttpRequest.prototype.send = originalSend;
          XMLHttpRequest.prototype.setRequestHeader = originalSetHeader;
        });
      });
    },
    args: [groupId, accountId, link, message || "", timeoutMs],
  });

  return results?.[0]?.result || {
    success: false,
    error: "NO_CAPTURE_RESULT",
    message: "ไม่พบผลลัพธ์จากการจับ request แชร์",
  };
}

async function deleteGroupPostViaTemplate(postId, groupId, accountId, template) {
  if (!template || !Array.isArray(template.params) || template.params.length === 0) {
    return {
      success: false,
      error: "MISSING_TEMPLATE",
      message: "ยังไม่มี template สำหรับลบแบบ no-tab กรุณาจับ request ก่อน",
    };
  }

  const tokenResult = await getFbDtsgForGroup(accountId);
  if (!tokenResult?.fbDtsg) {
    return {
      success: false,
      error: "NO_DTSG",
      message: tokenResult?.error || "ไม่พบ fb_dtsg สำหรับยิงลบแบบ no-tab",
    };
  }

  const replacements = {
    postId,
    groupId,
    accountId,
  };
  const body = new URLSearchParams();

  for (const entry of template.params) {
    if (!entry?.key) continue;

    let value = hydrateGroupDeleteTemplateNode(entry.value, replacements);

    if (entry.key === "fb_dtsg") {
      value = tokenResult.fbDtsg;
    } else if (entry.key === "lsd") {
      value = tokenResult.lsd || "";
    } else if (entry.key === "jazoest") {
      value = computeJazoest(tokenResult.fbDtsg);
    } else if (entry.key === "__user" || entry.key === "av") {
      value = accountId;
    }

    body.append(entry.key, String(value));
  }

  if (!body.has("fb_dtsg")) {
    body.append("fb_dtsg", tokenResult.fbDtsg);
  }
  if (!body.has("jazoest")) {
    body.append("jazoest", computeJazoest(tokenResult.fbDtsg));
  }
  if (tokenResult.lsd && !body.has("lsd")) {
    body.append("lsd", tokenResult.lsd);
  }
  if (!body.has("__user")) {
    body.append("__user", accountId);
  }

  const templateUrl =
    typeof template.url === "string" && template.url
      ? template.url
      : "https://www.facebook.com/api/graphql/";
  const absoluteUrl = /^https?:\/\//i.test(templateUrl)
    ? templateUrl
    : `https://www.facebook.com${templateUrl.startsWith("/") ? "" : "/"}${templateUrl}`;

  const response = await fbInternalApiRequest(
    absoluteUrl,
    String(template.method || "POST").toUpperCase(),
    body.toString(),
    {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(template.headers || {}),
    },
    accountId
  );

  const responsePayload =
    typeof response.data === "string"
      ? tryParseJsonLikeString(response.data) || { raw: response.data }
      : response.data;

  if (response.error) {
    return {
      success: false,
      error: "REQUEST_FAILED",
      message: response.error,
      status: response.status,
    };
  }

  if ((response.status || 0) >= 400) {
    return {
      success: false,
      error: "HTTP_ERROR",
      message: `Facebook ตอบกลับสถานะ ${response.status}`,
      status: response.status,
      response: responsePayload,
    };
  }

  if (responseHasErrors(responsePayload)) {
    return {
      success: false,
      error: "FACEBOOK_ERROR",
      message: "Facebook ตอบกลับว่าคำสั่งลบไม่สำเร็จ",
      status: response.status,
      response: responsePayload,
    };
  }

  if (!responseMatchesSuccessTemplate(responsePayload, template.successPaths)) {
    return {
      success: false,
      error: "DELETE_UNCONFIRMED",
      message: "ยิงคำสั่งแบบ no-tab แล้ว แต่ยังไม่เจอสัญญาณยืนยันความสำเร็จจาก response",
      status: response.status,
      response: responsePayload,
    };
  }

  return {
    success: true,
    message: "ลบโพสต์ในกลุ่มสำเร็จผ่าน no-tab engine",
    status: response.status,
    response: responsePayload,
  };
}

// Rate limit detection helper for group operations
function isRateLimitResponse(responsePayload) {
  const str = JSON.stringify(responsePayload || {}).toLowerCase();
  return /rate.?limit|spam|temporarily.?blocked|please.?slow.?down|try.?again.?later/.test(str);
}

async function shareGroupLinkViaTemplate(groupId, accountId, link, message, template) {
  if (!template || !Array.isArray(template.params) || template.params.length === 0) {
    return {
      success: false,
      error: "MISSING_TEMPLATE",
      message: "ยังไม่มี template สำหรับแชร์ลิงก์แบบ no-tab กรุณาจับ request ก่อน",
    };
  }

  // Inner function to execute a single share attempt
  async function executeShare(tokenResult) {
    const replacements = {
      groupId,
      accountId,
      link,
      message: message || "",
    };
    const body = new URLSearchParams();

    for (const entry of template.params) {
      if (!entry?.key) continue;

      let value = hydrateGroupShareTemplateNode(entry.value, replacements);

      if (entry.key === "fb_dtsg") {
        value = tokenResult.fbDtsg;
      } else if (entry.key === "lsd") {
        value = tokenResult.lsd || "";
      } else if (entry.key === "jazoest") {
        value = computeJazoest(tokenResult.fbDtsg);
      } else if (entry.key === "__user" || entry.key === "av") {
        value = accountId;
      }

      body.append(entry.key, String(value));
    }

    if (!body.has("fb_dtsg")) {
      body.append("fb_dtsg", tokenResult.fbDtsg);
    }
    if (!body.has("jazoest")) {
      body.append("jazoest", computeJazoest(tokenResult.fbDtsg));
    }
    if (tokenResult.lsd && !body.has("lsd")) {
      body.append("lsd", tokenResult.lsd);
    }
    if (!body.has("__user")) {
      body.append("__user", accountId);
    }

    // Ensure fresh session params (these are volatile and should not carry over from capture)
    if (!body.has("__a")) {
      body.append("__a", "1");
    }
    if (!body.has("__comet_req")) {
      body.append("__comet_req", "15");
    }
    body.delete("server_timestamps");
    body.append("server_timestamps", "true");

    const templateUrl =
      typeof template.url === "string" && template.url
        ? template.url
        : "https://www.facebook.com/api/graphql/";
    const absoluteUrl = /^https?:\/\//i.test(templateUrl)
      ? templateUrl
      : `https://www.facebook.com${templateUrl.startsWith("/") ? "" : "/"}${templateUrl}`;

    const response = await fbInternalApiRequest(
      absoluteUrl,
      String(template.method || "POST").toUpperCase(),
      body.toString(),
      {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(template.headers || {}),
      },
      accountId
    );

    const responsePayload =
      typeof response.data === "string"
        ? tryParseJsonLikeString(response.data) || { raw: response.data }
        : response.data;

    return { response, responsePayload };
  }

  // Attempt 1: use cached or fresh token
  let tokenResult = await getFbDtsgForGroup(accountId);
  if (!tokenResult?.fbDtsg) {
    return {
      success: false,
      error: "NO_DTSG",
      message: tokenResult?.error || "ไม่พบ fb_dtsg สำหรับยิงแชร์แบบ no-tab",
    };
  }

  let { response, responsePayload } = await executeShare(tokenResult);

  // Auto-retry with fresh token on auth errors (401/403)
  const httpStatus = response.status || 0;
  let retried = false;
  if (httpStatus === 401 || httpStatus === 403) {
    invalidateGroupTokenCache();
    tokenResult = await getFbDtsgForGroup(accountId, true);
    if (tokenResult?.fbDtsg) {
      const retry = await executeShare(tokenResult);
      response = retry.response;
      responsePayload = retry.responsePayload;
      retried = true;
    }
  }

  // Build debug log entry
  const logEntry = {
    operation: "SHARE_GROUP_LINK",
    groupId,
    accountId,
    httpStatus: response.status,
    retried,
    responseSnippet: JSON.stringify(responsePayload).slice(0, 500),
  };

  if (response.error) {
    logEntry.error = "REQUEST_FAILED";
    addGroupDebugEntry(logEntry);
    return {
      success: false,
      error: "REQUEST_FAILED",
      message: response.error,
      status: response.status,
    };
  }

  if ((response.status || 0) >= 400) {
    logEntry.error = "HTTP_ERROR";
    addGroupDebugEntry(logEntry);
    return {
      success: false,
      error: "HTTP_ERROR",
      message: `Facebook ตอบกลับสถานะ ${response.status}`,
      status: response.status,
      response: responsePayload,
    };
  }

  // Rate limit detection
  if (isRateLimitResponse(responsePayload)) {
    logEntry.error = "RATE_LIMITED";
    addGroupDebugEntry(logEntry);
    return {
      success: false,
      error: "RATE_LIMITED",
      message: "Facebook จำกัดอัตราการใช้งาน กรุณารอสักครู่แล้วลองใหม่",
      status: response.status,
      response: responsePayload,
    };
  }

  if (responseHasErrors(responsePayload)) {
    logEntry.error = "FACEBOOK_ERROR";
    addGroupDebugEntry(logEntry);
    return {
      success: false,
      error: "FACEBOOK_ERROR",
      message: "Facebook ตอบกลับว่าการแชร์ลิงก์ไม่สำเร็จ",
      status: response.status,
      response: responsePayload,
    };
  }

  if (!responseMatchesTruthyTemplate(responsePayload, template.successPaths)) {
    const noExplicitError = !responseHasErrors(responsePayload);
    const statusOk = (response.status || 0) >= 200 && (response.status || 0) < 300;

    logEntry.error = "SHARE_UNCONFIRMED";
    logEntry.maybeSucceeded = noExplicitError && statusOk;
    addGroupDebugEntry(logEntry);
    return {
      success: false,
      error: "SHARE_UNCONFIRMED",
      message: "ยิงคำสั่งแชร์แบบ no-tab แล้ว แต่ยังไม่เจอสัญญาณยืนยันความสำเร็จจาก response",
      maybeSucceeded: noExplicitError && statusOk,
      status: response.status,
      response: responsePayload,
    };
  }

  logEntry.error = null;
  addGroupDebugEntry(logEntry);
  return {
    success: true,
    message: "แชร์ลิงก์ลงกลุ่มสำเร็จผ่าน no-tab engine",
    status: response.status,
    response: responsePayload,
  };
}

// ─── Fetch User Groups ───

const GROUPS_QUERY_DOC_ID = "9273867932733772";

async function fetchUserGroups(accountId) {
  // 1. Get fb_dtsg
  const tokenResult = await getFbDtsgForGroup(accountId);
  if (!tokenResult?.fbDtsg) {
    return { success: false, groups: [], error: tokenResult?.error || "ไม่พบ fb_dtsg" };
  }

  const allGroups = [];
  const seen = new Set();
  let cursor = null;
  let hasMore = true;

  // Paginate through all groups (20 per page)
  while (hasMore) {
    const body = new URLSearchParams({
      av: accountId,
      __user: accountId,
      __a: "1",
      fb_dtsg: tokenResult.fbDtsg,
      jazoest: computeJazoest(tokenResult.fbDtsg),
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "GroupsCometAllJoinedGroupsSectionPaginationQuery",
      server_timestamps: "true",
      doc_id: GROUPS_QUERY_DOC_ID,
      variables: JSON.stringify({
        count: 20,
        cursor,
        ordering: ["viewer_visitation"],
        scale: 1,
      }),
    });

    if (tokenResult.lsd) body.append("lsd", tokenResult.lsd);

    const response = await fbInternalApiRequest(
      "https://www.facebook.com/api/graphql/",
      "POST",
      body.toString(),
      { "Content-Type": "application/x-www-form-urlencoded" },
      accountId
    );

    // Parse response (may be multi-line JSON)
    let payload = null;
    const raw = typeof response.data === "string" ? response.data : JSON.stringify(response.data || "");
    const lines = raw.replace(/^for\s*\(;;\)\s*;\s*/, "").split("\n");
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed?.data) { payload = parsed; break; }
      } catch {}
    }
    if (!payload) {
      try { payload = typeof response.data === "object" ? response.data : null; } catch {}
    }

    if (!payload?.data) break;

    // Extract groups from response using deep search
    const edges = deepFindKey(payload, "edges");
    if (Array.isArray(edges)) {
      for (const edge of edges) {
        const node = edge?.node;
        if (!node) continue;
        const id = node.id || node.group_id;
        const name = node.name || deepFindKey(node, "name");
        if (id && name && !seen.has(id)) {
          seen.add(id);
          allGroups.push({ id: String(id), name: String(name) });
        }
      }
    }

    // Check for next page
    const pageInfo = deepFindKey(payload, "page_info");
    if (pageInfo?.has_next_page && pageInfo?.end_cursor) {
      cursor = pageInfo.end_cursor;
    } else {
      hasMore = false;
    }

    // Safety: max 10 pages (200 groups)
    if (allGroups.length >= 200) break;
  }

  return { success: true, groups: allGroups };
}

// ─── Direct Group Link Share (no capture needed) ───

const DIRECT_SHARE_SUCCESS_PATHS = [
  "data.story_create.story.id",
  "data.story_create.story.legacy_story_hideable_id",
  "data.story_create.story.url",
  "data.story_create.story.permalink_url",
  "data.group_create_post.story.id",
  "data.create_story.story.id",
  "data.composerStoryCreate.story.id",
];

// Deep-search an object tree for a key, returning the first match
function deepFindKey(obj, targetKey, visited = new WeakSet()) {
  if (!obj || typeof obj !== "object") return undefined;
  if (visited.has(obj)) return undefined;
  visited.add(obj);
  if (targetKey in obj) return obj[targetKey];
  for (const value of Object.values(obj)) {
    const found = deepFindKey(value, targetKey, visited);
    if (found !== undefined) return found;
  }
  return undefined;
}

// Deep-search for all values of a given key in an object tree
function deepFindAllValues(obj, targetKey, results = [], visited = new WeakSet()) {
  if (!obj || typeof obj !== "object") return results;
  if (visited.has(obj)) return results;
  visited.add(obj);
  if (targetKey in obj) results.push(obj[targetKey]);
  for (const value of Object.values(obj)) {
    deepFindAllValues(value, targetKey, results, visited);
  }
  return results;
}

// Resolve a Facebook URL to get share_scrape_data via CometUnifiedShareSheetDialogQuery
async function resolveShareScrapeData(url, accountId, tokens) {
  try {
    const body = new URLSearchParams({
      av: accountId,
      __user: accountId,
      __a: "1",
      __comet_req: "15",
      fb_dtsg: tokens.fbDtsg,
      jazoest: computeJazoest(tokens.fbDtsg),
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: "CometUnifiedShareSheetDialogQuery",
      server_timestamps: "true",
      doc_id: SHARE_DIALOG_QUERY_DOC_ID,
      variables: JSON.stringify({
        feedLocation: "NEWSFEED",
        hasParentStory: true,
        isComposerDisabled: false,
        isLinkSharingEnabled: false,
        isShareToFeedDisabled: false,
        isShareToFriendFeedEnabled: true,
        privacySelectorRenderLocation: "COMET_COMPOSER",
        qe_optional_share_to_page: true,
        scale: 1,
        shareableParams: { url },
        storyParams: { url },
      }),
    });

    if (tokens.lsd) {
      body.append("lsd", tokens.lsd);
    }

    const response = await fbInternalApiRequest(
      "https://www.facebook.com/api/graphql/",
      "POST",
      body.toString(),
      { "Content-Type": "application/x-www-form-urlencoded" },
      accountId
    );

    const payload =
      typeof response.data === "string"
        ? tryParseJsonLikeString(response.data) || {}
        : response.data || {};

    // Strategy 1: Find share_scrape_data directly in the parsed response tree
    const scrapeDataValue = deepFindKey(payload, "share_scrape_data");
    if (scrapeDataValue && typeof scrapeDataValue === "string" && scrapeDataValue.includes("share_type")) {
      return scrapeDataValue;
    }

    // Strategy 2: Find share_type + share_params in response and build the string
    const shareType = deepFindKey(payload, "share_type");
    const shareParams = deepFindKey(payload, "share_params");
    if (shareType !== undefined && Array.isArray(shareParams) && shareParams.length > 0) {
      // Use string template to preserve large number precision
      return `{"share_type":${shareType},"share_params":[${shareParams.map(String).join(",")}]}`;
    }

    // Strategy 3: Find a shareable ID and construct share_scrape_data
    const shareableId = deepFindKey(payload, "shareable_attachment_id")
      || deepFindKey(payload, "share_id");
    if (shareableId) {
      return `{"share_type":99,"share_params":[${shareableId}]}`;
    }

    // Strategy 4: Find post/story ID from the story node
    const storyId = deepFindKey(payload, "post_id")
      || deepFindKey(payload, "story_id");
    if (storyId && /^\d{10,}$/.test(String(storyId))) {
      return `{"share_type":99,"share_params":[${storyId}]}`;
    }

    // Strategy 5: Look for any large numeric ID in "id" fields within story/node context
    const allIds = deepFindAllValues(payload, "id");
    const largeNumericId = allIds.find(
      (id) => typeof id === "string" && /^\d{15,}$/.test(id)
    );
    if (largeNumericId) {
      return `{"share_type":99,"share_params":[${largeNumericId}]}`;
    }

    return null;
  } catch {
    return null;
  }
}

// Build variables matching the exact structure that Adverraorder uses (proven to work)
function buildGroupShareVariables(groupId, accountId, shareScrapeData, message) {
  return JSON.stringify({
    input: {
      composer_entry_point: "inline_composer",
      composer_source_surface: "group",
      composer_type: "group",
      source: "WWW",
      is_tracking_encrypted: true,
      message: {
        ranges: [],
        text: message || "",
      },
      with_tags_ids: null,
      inline_activities: [],
      text_format_preset_id: "0",
      attachments: [
        {
          link: {
            share_scrape_data: shareScrapeData,
          },
        },
      ],
      event_share_metadata: {
        surface: "newsfeed",
      },
      audience: {
        to_id: groupId,
      },
      actor_id: accountId,
      client_mutation_id: "1",
    },
    feedLocation: "GROUP",
    feedbackSource: 0,
    focusCommentID: null,
    gridMediaWidth: null,
    groupID: null,
    scale: 1,
    privacySelectorRenderLocation: "COMET_STREAM",
    checkPhotosToReelsUpsellEligibility: false,
    renderLocation: "group",
    useDefaultActor: false,
    inviteShortLinkKey: null,
    isFeed: false,
    isFundraiser: false,
    isFunFactPost: false,
    isGroup: true,
    isEvent: false,
    isTimeline: false,
    isSocialLearning: false,
    isPageNewsFeed: false,
    isProfileReviews: false,
    isWorkSharedDraft: false,
    hashtag: null,
    canUserManageOffers: false,
  });
}

async function shareGroupLinkDirect(groupId, accountId, link, message = "") {
  // 1. Get fb_dtsg tokens
  let tokenResult = await getFbDtsgForGroup(accountId);
  if (!tokenResult?.fbDtsg) {
    return {
      success: false,
      error: "NO_DTSG",
      message: tokenResult?.error || "ไม่พบ fb_dtsg สำหรับยิงแชร์",
    };
  }

  // 2. Discover doc_id for the composer mutation
  const docResult = await discoverComposerDocId(accountId);
  if (!docResult?.docId) {
    return {
      success: false,
      error: "NO_DOC_ID",
      message: docResult?.error || "ไม่พบ doc_id สำหรับ Composer mutation",
    };
  }

  // 3. Resolve the link to get share_scrape_data via CometUnifiedShareSheetDialogQuery
  const shareScrapeData = await resolveShareScrapeData(link, accountId, tokenResult);
  if (!shareScrapeData) {
    return {
      success: false,
      error: "NO_SHARE_DATA",
      message: "ไม่สามารถ resolve ลิงก์เพื่อเอา share data ได้ — ตรวจสอบว่าลิงก์ถูกต้องและเปิดได้",
    };
  }

  // Inner function to execute a single share attempt
  async function executeDirectShare(tokens) {
    const body = new URLSearchParams({
      av: accountId,
      __aaid: "0",
      __user: accountId,
      __a: "1",
      __comet_req: "15",
      dpr: "1",
      fb_dtsg: tokens.fbDtsg,
      jazoest: computeJazoest(tokens.fbDtsg),
      fb_api_caller_class: "RelayModern",
      fb_api_req_friendly_name: docResult.friendlyName || "ComposerStoryCreateMutation",
      server_timestamps: "true",
      doc_id: docResult.docId,
      variables: buildGroupShareVariables(groupId, accountId, shareScrapeData, message),
    });

    if (tokens.lsd) {
      body.append("lsd", tokens.lsd);
    }

    const response = await fbInternalApiRequest(
      "https://www.facebook.com/api/graphql/",
      "POST",
      body.toString(),
      { "Content-Type": "application/x-www-form-urlencoded" },
      accountId
    );

    const responsePayload =
      typeof response.data === "string"
        ? tryParseJsonLikeString(response.data) || { raw: response.data }
        : response.data;

    return { response, responsePayload };
  }

  // Attempt 1
  let { response, responsePayload } = await executeDirectShare(tokenResult);

  // Auto-retry on 401/403 with fresh token
  const httpStatus = response.status || 0;
  let retried = false;
  if (httpStatus === 401 || httpStatus === 403) {
    invalidateGroupTokenCache();
    tokenResult = await getFbDtsgForGroup(accountId, true);
    if (tokenResult?.fbDtsg) {
      const retry = await executeDirectShare(tokenResult);
      response = retry.response;
      responsePayload = retry.responsePayload;
      retried = true;
    }
  }

  // Auto-invalidate doc_id on certain errors (stale doc_id)
  if (httpStatus === 400) {
    const errStr = JSON.stringify(responsePayload || "");
    if (/unknown.*document|invalid.*doc_id|unknown.*query/i.test(errStr)) {
      invalidateComposerDocIdCache();
    }
  }

  // Build debug log entry
  const logEntry = {
    operation: "SHARE_GROUP_LINK_DIRECT",
    groupId,
    accountId,
    docId: docResult.docId,
    friendlyName: docResult.friendlyName,
    shareScrapeData: typeof shareScrapeData === "string" ? shareScrapeData.slice(0, 200) : JSON.stringify(shareScrapeData).slice(0, 200),
    httpStatus: response.status,
    retried,
    responseSnippet: JSON.stringify(responsePayload).slice(0, 500),
  };

  if (response.error) {
    logEntry.error = "REQUEST_FAILED";
    addGroupDebugEntry(logEntry);
    return {
      success: false,
      error: "REQUEST_FAILED",
      message: response.error,
      status: response.status,
    };
  }

  if ((response.status || 0) >= 400) {
    logEntry.error = "HTTP_ERROR";
    addGroupDebugEntry(logEntry);
    return {
      success: false,
      error: "HTTP_ERROR",
      message: `Facebook ตอบกลับสถานะ ${response.status}`,
      status: response.status,
      response: responsePayload,
    };
  }

  // If response came as { raw: "..." }, try to parse the inner string
  // Facebook often sends multiple JSON objects on separate lines
  let parsedPayload = responsePayload;
  if (responsePayload?.raw && typeof responsePayload.raw === "string") {
    const rawText = stripForLoopPrefix(responsePayload.raw);
    // Try parsing each line as separate JSON and find the one with story_create
    const lines = rawText.split("\n").filter((l) => l.trim().startsWith("{"));
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed?.data?.story_create !== undefined) {
          parsedPayload = parsed;
          break;
        }
        // Keep first successful parse as fallback
        if (parsedPayload === responsePayload) {
          parsedPayload = parsed;
        }
      } catch {}
    }
  }

  // Check for SUCCESS first (before rate limit/errors)
  // because Facebook may include warnings alongside successful data
  const storyUrl = deepFindKey(parsedPayload, "url");
  const storyId = deepFindKey(parsedPayload, "legacy_story_hideable_id")
    || deepFindKey(parsedPayload, "post_id")
    || deepFindKey(parsedPayload, "story_id");
  const storyCreate = parsedPayload?.data?.story_create;

  if (storyCreate?.story?.url || storyCreate?.story?.id || (storyId && String(storyId).length > 5)) {
    logEntry.error = null;
    logEntry.postUrl = storyCreate?.story?.url || storyUrl;
    logEntry.postId = storyId;
    addGroupDebugEntry(logEntry);
    return {
      success: true,
      message: "แชร์ลิงก์ลงกลุ่มสำเร็จ",
      status: response.status,
      response: parsedPayload,
    };
  }

  // Also check via success paths
  if (responseMatchesTruthyTemplate(parsedPayload, DIRECT_SHARE_SUCCESS_PATHS)) {
    logEntry.error = null;
    addGroupDebugEntry(logEntry);
    return {
      success: true,
      message: "แชร์ลิงก์ลงกลุ่มสำเร็จ",
      status: response.status,
      response: parsedPayload,
    };
  }

  // Rate limit detection (only if NOT successful)
  if (isRateLimitResponse(parsedPayload)) {
    logEntry.error = "RATE_LIMITED";
    addGroupDebugEntry(logEntry);
    return {
      success: false,
      error: "RATE_LIMITED",
      message: "Facebook จำกัดอัตราการใช้งาน กรุณารอสักครู่แล้วลองใหม่",
      status: response.status,
      response: parsedPayload,
    };
  }

  if (responseHasErrors(parsedPayload)) {
    const fbErrorMsg =
      parsedPayload?.error?.message ||
      parsedPayload?.errors?.[0]?.message ||
      parsedPayload?.error?.description ||
      (typeof parsedPayload?.error === "string" ? parsedPayload.error : null) ||
      JSON.stringify(parsedPayload).slice(0, 300);
    logEntry.error = "FACEBOOK_ERROR";
    logEntry.fbError = fbErrorMsg;
    addGroupDebugEntry(logEntry);
    return {
      success: false,
      error: "FACEBOOK_ERROR",
      message: `Facebook error: ${fbErrorMsg}`,
      status: response.status,
      response: parsedPayload,
    };
  }

  // If we got here, response has no clear success or error signal
  const noExplicitError = !responseHasErrors(parsedPayload);
  const statusOk = (response.status || 0) >= 200 && (response.status || 0) < 300;

  logEntry.error = "SHARE_UNCONFIRMED";
  logEntry.maybeSucceeded = noExplicitError && statusOk;
  addGroupDebugEntry(logEntry);
  return {
    success: false,
    error: "SHARE_UNCONFIRMED",
    message: "ยิงคำสั่งแชร์แล้ว แต่ยังไม่เจอสัญญาณยืนยันจาก response",
    maybeSucceeded: noExplicitError && statusOk,
    status: response.status,
    response: parsedPayload,
  };
}

async function deleteGroupPostViaUi(postId, groupId, accountId) {
  const targetUrls = [
    `https://www.facebook.com/groups/${groupId}/posts/${postId}/`,
    `https://www.facebook.com/groups/${groupId}/permalink/${postId}/`,
  ];
  let lastResult = { success: false, error: "No result" };

  for (const targetUrl of targetUrls) {
    let tabId = null;

    try {
      const tab = await chrome.tabs.create({
        url: targetUrl,
        active: false,
      });
      tabId = tab.id ?? null;

      if (!tabId) {
        lastResult = {
          success: false,
          error: "TAB_CREATE_FAILED",
          message: "ไม่สามารถเปิดแท็บสำหรับลบโพสต์กลุ่มได้",
          openedUrl: targetUrl,
        };
        continue;
      }

      const loaded = await waitForTabComplete(tabId, 20000);
      if (!loaded) {
        lastResult = {
          success: false,
          error: "TAB_LOAD_TIMEOUT",
          message: "โหลดหน้าโพสต์กลุ่มไม่ทันเวลา",
          openedUrl: targetUrl,
        };
        continue;
      }

      await new Promise((resolve) => setTimeout(resolve, 2500));

      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: async (expectedAccountId) => {
          const sleep = (ms) =>
            new Promise((resolve) => setTimeout(resolve, ms));
          const normalize = (value) =>
            String(value || "")
              .replace(/\s+/g, " ")
              .trim()
              .toLowerCase();
          const visible = (element) => {
            if (!(element instanceof HTMLElement)) {
              return false;
            }

            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return (
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0" &&
              rect.width > 0 &&
              rect.height > 0
            );
          };
          const labelOf = (element) => {
            if (!(element instanceof HTMLElement)) {
              return "";
            }

            return [
              element.getAttribute("aria-label") || "",
              element.getAttribute("title") || "",
              element.innerText || "",
              element.textContent || "",
            ]
              .join(" ")
              .replace(/\s+/g, " ")
              .trim();
          };
          const matchesAny = (text, patterns) =>
            patterns.some((pattern) => pattern.test(text));
          const queryVisible = (root, selector) =>
            Array.from(root.querySelectorAll(selector)).filter(visible);
          const clickElement = (element) => {
            element.scrollIntoView({
              block: "center",
              inline: "center",
              behavior: "instant",
            });

            if (typeof PointerEvent === "function") {
              element.dispatchEvent(
                new PointerEvent("pointerdown", {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                })
              );
              element.dispatchEvent(
                new PointerEvent("pointerup", {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                })
              );
            }

            element.dispatchEvent(
              new MouseEvent("mousedown", {
                bubbles: true,
                cancelable: true,
                view: window,
              })
            );
            element.dispatchEvent(
              new MouseEvent("mouseup", {
                bubbles: true,
                cancelable: true,
                view: window,
              })
            );
            element.click();
          };
          const waitFor = async (resolver, attempts = 18, delayMs = 350) => {
            for (let attempt = 0; attempt < attempts; attempt += 1) {
              const result = resolver();
              if (result) {
                return result;
              }
              await sleep(delayMs);
            }

            return null;
          };

          const menuPatterns = [
            /actions for this post/i,
            /post actions/i,
            /more options/i,
            /^more$/i,
            /^options$/i,
            /ตัวเลือก/i,
            /เพิ่มเติม/i,
            /การดำเนินการ/i,
          ];
          const ignoreMenuPatterns = [/see more/i, /ดูเพิ่มเติม/];
          const strongDeletePatterns = [
            /\bdelete post\b/i,
            /\bmove to trash\b/i,
            /\bdelete permanently\b/i,
            /ลบโพสต์/,
            /ย้ายไปถังขยะ/,
            /ลบถาวร/,
          ];
          const weakDeletePatterns = [/^delete$/i, /^trash$/i, /^ลบ$/];
          const confirmPatterns = [
            /\bdelete\b/i,
            /\bmove to trash\b/i,
            /\bconfirm\b/i,
            /ลบ/,
            /ยืนยัน/,
            /ถังขยะ/,
          ];
          const unavailablePatterns = [
            /content isn't available/i,
            /this page isn't available/i,
            /this content isn't available/i,
            /เนื้อหานี้ไม่พร้อมใช้งาน/,
            /ไม่สามารถใช้งานเนื้อหานี้ได้/,
            /ไม่พบเนื้อหานี้/,
            /โพสต์นี้อาจถูกลบไปแล้ว/,
          ];
          const errorPatterns = [
            /something went wrong/i,
            /an error occurred/i,
            /เกิดข้อผิดพลาด/,
          ];
          const successPatterns = [
            /post deleted/i,
            /moved to trash/i,
            /ย้ายไปถังขยะแล้ว/,
            /ลบโพสต์แล้ว/,
            /โพสต์ถูกลบแล้ว/,
          ];
          const textSnapshot = () => normalize(document.body?.innerText || "");

          const cUserMatch = document.cookie.match(/(?:^|;\s*)c_user=(\d+)/);
          const activeAccountId = cUserMatch ? cUserMatch[1] : null;

          if (expectedAccountId && !activeAccountId) {
            return {
              success: false,
              error: "NO_CUSER",
              message: "ไม่พบบัญชี Facebook ที่เปิดใช้งานอยู่ในแท็บนี้",
            };
          }

          if (
            expectedAccountId &&
            activeAccountId &&
            activeAccountId !== expectedAccountId
          ) {
            return {
              success: false,
              error: "ACTIVE_ACCOUNT_MISMATCH",
              message: `บัญชี Facebook ที่เปิดอยู่คือ ${activeAccountId} ไม่ตรงกับบัญชีที่เลือก ${expectedAccountId}`,
              activeAccountId,
            };
          }

          const initialText = textSnapshot();
          if (matchesAny(initialText, unavailablePatterns)) {
            return {
              success: false,
              error: "POST_UNAVAILABLE",
              message: "ไม่พบโพสต์นี้ หรือบัญชีนี้ไม่มีสิทธิ์เข้าถึงโพสต์ในกลุ่ม",
              activeAccountId,
            };
          }

          const article =
            (await waitFor(
              () =>
                queryVisible(document, '[role="article"]').find(
                  (candidate) => candidate instanceof HTMLElement
                ) || null,
              20,
              400
            )) || document.body;

          const findMenuButton = (root) => {
            const candidates = queryVisible(
              root,
              'button, div[role="button"], [aria-haspopup="menu"]'
            )
              .map((element) => {
                const label = normalize(labelOf(element));
                if (!label || matchesAny(label, ignoreMenuPatterns)) {
                  return null;
                }

                let score = 0;
                if (matchesAny(label, menuPatterns)) {
                  score += 5;
                }
                if (element.getAttribute("aria-haspopup") === "menu") {
                  score += 2;
                }
                if (element.closest('[role="article"]')) {
                  score += 1;
                }

                return score > 0 ? { element, label, score } : null;
              })
              .filter(Boolean)
              .sort((left, right) => right.score - left.score);

            return candidates[0]?.element || null;
          };

          const menuButton = findMenuButton(article) || findMenuButton(document);
          if (!menuButton) {
            return {
              success: false,
              error: "MENU_NOT_FOUND",
              message: "ไม่พบเมนูจัดการโพสต์ในกลุ่ม อาจเป็นโพสต์ที่ลบไม่ได้หรือหน้าตา Facebook เปลี่ยนไป",
              activeAccountId,
            };
          }

          const matchedMenuLabel = labelOf(menuButton);
          clickElement(menuButton);
          await sleep(700);

          const findDeleteAction = () => {
            const candidates = queryVisible(
              document,
              '[role="menuitem"], button, div[role="button"], a, div[tabindex="0"]'
            )
              .map((element) => {
                const label = normalize(labelOf(element));
                if (!label) {
                  return null;
                }

                let score = 0;
                if (matchesAny(label, strongDeletePatterns)) {
                  score += 7;
                }
                if (matchesAny(label, weakDeletePatterns)) {
                  score += 4;
                }
                if (element.closest('[role="menu"], [role="dialog"]')) {
                  score += 2;
                }
                if (label.includes("post") || label.includes("โพสต์")) {
                  score += 1;
                }

                return score > 0 ? { element, label, score } : null;
              })
              .filter(Boolean)
              .sort((left, right) => right.score - left.score);

            return candidates[0]?.element || null;
          };

          const deleteAction = await waitFor(findDeleteAction, 18, 350);
          if (!deleteAction) {
            return {
              success: false,
              error: "DELETE_ACTION_NOT_FOUND",
              message: "ไม่พบปุ่มลบโพสต์ในกลุ่ม บัญชีนี้อาจยังไม่มีสิทธิ์ลบโพสต์นี้",
              activeAccountId,
              matchedMenuLabel,
            };
          }

          const matchedActionLabel = labelOf(deleteAction);
          clickElement(deleteAction);
          await sleep(600);

          const findConfirmButton = () => {
            const dialogRoot =
              queryVisible(document, '[role="dialog"]').find(
                (candidate) => candidate instanceof HTMLElement
              ) || document;
            const candidates = queryVisible(
              dialogRoot,
              'button, div[role="button"], [role="menuitem"]'
            )
              .map((element) => {
                const label = normalize(labelOf(element));
                if (!label) {
                  return null;
                }

                let score = 0;
                if (matchesAny(label, strongDeletePatterns)) {
                  score += 7;
                }
                if (matchesAny(label, confirmPatterns)) {
                  score += 4;
                }
                if (element.closest('[role="dialog"]')) {
                  score += 2;
                }

                return score > 0 ? { element, label, score } : null;
              })
              .filter(Boolean)
              .sort((left, right) => right.score - left.score);

            return candidates[0]?.element || null;
          };

          const confirmButton = await waitFor(findConfirmButton, 12, 350);
          const matchedConfirmLabel = confirmButton
            ? labelOf(confirmButton)
            : null;

          if (confirmButton) {
            clickElement(confirmButton);
            await sleep(2500);
          } else {
            await sleep(2000);
          }

          const finalText = textSnapshot();
          const postStillVisible = Boolean(
            queryVisible(document, '[role="article"]').length
          );
          const confirmAttempted = Boolean(confirmButton);
          const looksSuccessful =
            matchesAny(finalText, successPatterns) ||
            matchesAny(finalText, unavailablePatterns) ||
            !postStillVisible;

          if (matchesAny(finalText, errorPatterns) && !looksSuccessful) {
            return {
              success: false,
              error: "DELETE_FAILED",
              message: "Facebook ตอบกลับว่าดำเนินการลบไม่สำเร็จ",
              activeAccountId,
              matchedMenuLabel,
              matchedActionLabel,
              matchedConfirmLabel,
            };
          }

          if (!looksSuccessful) {
            return {
              success: false,
              error: "DELETE_UNCONFIRMED",
              message: confirmAttempted
                ? "กดปุ่มลบแล้ว แต่ยังยืนยันไม่ได้ว่าโพสต์หายจาก Facebook จริง"
                : "ส่งคำสั่งลบแล้ว แต่ยังยืนยันผลลบจากหน้า Facebook ไม่ได้",
              activeAccountId,
              matchedMenuLabel,
              matchedActionLabel,
              matchedConfirmLabel,
            };
          }

          return {
            success: true,
            message: confirmButton
              ? "ลบโพสต์ในกลุ่มสำเร็จ"
              : "ส่งคำสั่งลบโพสต์ในกลุ่มแล้ว",
            activeAccountId,
            matchedMenuLabel,
            matchedActionLabel,
            matchedConfirmLabel,
          };
        },
        args: [accountId],
      });

      const result = results?.[0]?.result || {
        success: false,
        error: "NO_RESULT",
        message: "ไม่พบผลลัพธ์จากแท็บลบโพสต์กลุ่ม",
      };

      lastResult = {
        ...result,
        openedUrl: targetUrl,
      };

      if (result?.success) {
        return lastResult;
      }
    } catch (error) {
      lastResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        openedUrl: targetUrl,
      };
    } finally {
      if (tabId) {
        await chrome.tabs.remove(tabId).catch(() => {});
      }
    }
  }

  return lastResult;
}

async function deleteGroupPost(postId, groupId, accountId, template) {
  if (template) {
    const templateResult = await deleteGroupPostViaTemplate(
      postId,
      groupId,
      accountId,
      template
    );
    if (templateResult?.success || templateResult?.error !== "DELETE_UNCONFIRMED") {
      return {
        ...templateResult,
        engine: "template",
      };
    }
  }

  const fallbackResult = await deleteGroupPostViaUi(postId, groupId, accountId);
  return {
    ...fallbackResult,
    engine: "ui",
  };
}

async function hidePost(postId, accountId, explicitPageId) {
  const fbTabs = await chrome.tabs.query({
    url: [
      "*://*.facebook.com/*",
      "*://business.facebook.com/*",
      "*://adsmanager.facebook.com/*",
    ],
  });
  if (fbTabs.length === 0) {
    return { success: false, error: "No Facebook tab open" };
  }

  const sortedTabs = [...fbTabs].sort(
    (a, b) => getHideTabPriority(a.url) - getHideTabPriority(b.url)
  );
  let lastResult = { success: false, error: "No result" };

  for (const tab of sortedTabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        world: "MAIN",
        func: async (rawPostId, fallbackAccountId, pageIdFromCaller) => {
          return new Promise((resolve) => {
            try {
              const stripGraphqlPrefix = (text) =>
                text.replace(/^for\s*\(;;\)\s*;\s*/, "").trim();
              const html = document.documentElement.innerHTML;
              let fbDtsg = null;
              const dtsgPatterns = [
                /"DTSGInitData".*?"token"\s*:\s*"([^"]+)"/,
                /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/,
                /name="fb_dtsg"\s+value="([^"]+)"/,
                /"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/,
              ];

              for (const pattern of dtsgPatterns) {
                const match = html.match(pattern);
                if (match?.[1]) {
                  fbDtsg = match[1];
                  break;
                }
              }

              if (!fbDtsg) {
                resolve({ success: false, error: "NO_DTSG", message: "ไม่พบ fb_dtsg — ลอง refresh หน้า Facebook" });
                return;
              }

              let lsd = "";
              const lsdPatterns = [
                /"LSD".*?"token"\s*:\s*"([^"]+)"/,
                /\["LSD",\[\],\{"token":"([^"]+)"/,
                /name="lsd"\s+value="([^"]+)"/,
              ];

              for (const pattern of lsdPatterns) {
                const match = html.match(pattern);
                if (match?.[1]) {
                  lsd = match[1];
                  break;
                }
              }

              const cUserMatch = document.cookie.match(/c_user=(\d+)/);
              const cUser = cUserMatch ? cUserMatch[1] : fallbackAccountId;
              if (!cUser) {
                resolve({ success: false, error: "NO_CUSER", message: "ไม่พบ c_user cookie" });
                return;
              }

              let jazoestSum = 0;
              for (let i = 0; i < fbDtsg.length; i += 1) {
                jazoestSum += fbDtsg.charCodeAt(i);
              }

              const actualPostId = rawPostId.includes("_")
                ? rawPostId.split("_")[1]
                : rawPostId;
              const pId = pageIdFromCaller || (rawPostId.includes("_") ? rawPostId.split("_")[0] : "");
              if (!pId || !actualPostId) {
                resolve({ success: false, error: "INVALID_POST_ID" });
                return;
              }
              const storyId = btoa(`S:_I${pId}:${actualPostId}:${actualPostId}`);

              const requestVariants = [
                new URLSearchParams({
                  fb_dtsg: fbDtsg,
                  jazoest: `2${jazoestSum}`,
                  lsd,
                  fb_api_caller_class: "RelayModern",
                  fb_api_req_friendly_name: "CometActivityLogItemCurationMutation",
                  server_timestamps: "true",
                  doc_id: "24411931498505270",
                  variables: JSON.stringify({
                    input: {
                      category_key: "MANAGEPOSTSPHOTOSANDVIDEOS",
                      post_id_str: actualPostId,
                      story_id: storyId,
                      story_location: "ACTIVITY_LOG",
                      structured_error_handling: true,
                      timeline_visibility: "HIDE",
                      actor_id: pId,
                      client_mutation_id: "1",
                    },
                  }),
                }),
                new URLSearchParams({
                  av: pId,
                  __user: pId,
                  __a: "1",
                  __comet_req: "15",
                  fb_dtsg: fbDtsg,
                  lsd,
                  jazoest: `2${jazoestSum}`,
                  fb_api_caller_class: "RelayModern",
                  fb_api_req_friendly_name: "CometActivityLogItemCurationMutation",
                  server_timestamps: "true",
                  doc_id: "24411931498505270",
                  variables: JSON.stringify({
                    input: {
                      category_key: "MANAGEPOSTSPHOTOSANDVIDEOS",
                      post_id_str: actualPostId,
                      story_id: storyId,
                      story_location: "ACTIVITY_LOG",
                      structured_error_handling: true,
                      timeline_visibility: "HIDE",
                      actor_id: pId,
                      client_mutation_id: "1",
                    },
                  }),
                }),
                new URLSearchParams({
                  av: pId,
                  __user: cUser,
                  __a: "1",
                  __comet_req: "15",
                  fb_dtsg: fbDtsg,
                  lsd,
                  jazoest: `2${jazoestSum}`,
                  fb_api_caller_class: "RelayModern",
                  fb_api_req_friendly_name: "CometActivityLogItemCurationMutation",
                  server_timestamps: "true",
                  doc_id: "24411931498505270",
                  variables: JSON.stringify({
                    input: {
                      category_key: "MANAGEPOSTSPHOTOSANDVIDEOS",
                      post_id_str: actualPostId,
                      story_id: storyId,
                      story_location: "ACTIVITY_LOG",
                      structured_error_handling: true,
                      timeline_visibility: "HIDE",
                      actor_id: pId,
                      client_mutation_id: "1",
                    },
                  }),
                }),
              ];

              const sendVariant = (index) => {
                if (index >= requestVariants.length) {
                  resolve({
                    success: false,
                    error: "FB_REJECTED",
                    raw: "all hide variants rejected",
                  });
                  return;
                }

                const xhr = new XMLHttpRequest();
                xhr.open("POST", "/api/graphql/");
                xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
                xhr.onload = function onload() {
                  const text = stripGraphqlPrefix(xhr.responseText || "");

                  try {
                    const parsed = JSON.parse(text);
                    const curation = parsed?.data?.activity_log_story_curation;

                    if (curation?.success === true) {
                      resolve({ success: true });
                      return;
                    }

                    sendVariant(index + 1);
                  } catch {
                    resolve({
                      success: false,
                      error: "PARSE_ERROR",
                      raw: text.slice(0, 500),
                    });
                  }
                };
                xhr.onerror = function onerror() {
                  resolve({ success: false, error: "XHR_ERROR" });
                };
                xhr.send(requestVariants[index].toString());
              };

              sendVariant(0);
            } catch (error) {
              resolve({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          });
        },
        args: [postId, accountId, explicitPageId],
      });

      const result = results?.[0]?.result || { success: false, error: "No result" };
      if (result?.success) {
        return result;
      }
      lastResult = result;
    } catch (error) {
      lastResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const hasPreferredFacebookTab = sortedTabs.some(
    (tab) => getHideTabPriority(tab.url) <= 1
  );

  if (!hasPreferredFacebookTab) {
    let fallbackTabId = null;
    try {
      const fallbackTab = await chrome.tabs.create({
        url: "https://www.facebook.com/pages/?category=your_pages&ref=bookmarks",
        active: false,
      });
      fallbackTabId = fallbackTab.id ?? null;

      if (fallbackTabId) {
        const loaded = await waitForTabComplete(fallbackTabId, 15000);
        if (loaded) {
          await new Promise((resolve) => setTimeout(resolve, 2000));

          const results = await chrome.scripting.executeScript({
            target: { tabId: fallbackTabId },
            world: "MAIN",
            func: async (rawPostId, fallbackAccountId, pageIdFromCaller) => {
              return new Promise((resolve) => {
                try {
                  const stripGraphqlPrefix = (text) =>
                    text.replace(/^for\s*\(;;\)\s*;\s*/, "").trim();
                  const html = document.documentElement.innerHTML;
                  let fbDtsg = null;
                  const dtsgPatterns = [
                    /"DTSGInitData".*?"token"\s*:\s*"([^"]+)"/,
                    /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/,
                    /name="fb_dtsg"\s+value="([^"]+)"/,
                    /"dtsg"\s*:\s*\{"token"\s*:\s*"([^"]+)"/,
                  ];

                  for (const pattern of dtsgPatterns) {
                    const match = html.match(pattern);
                    if (match?.[1]) {
                      fbDtsg = match[1];
                      break;
                    }
                  }

                  if (!fbDtsg) {
                    resolve({ success: false, error: "NO_DTSG", message: "ไม่พบ fb_dtsg — ลอง refresh หน้า Facebook" });
                    return;
                  }

                  let lsd = "";
                  const lsdPatterns = [
                    /"LSD".*?"token"\s*:\s*"([^"]+)"/,
                    /\["LSD",\[\],\{"token":"([^"]+)"/,
                    /name="lsd"\s+value="([^"]+)"/,
                  ];

                  for (const pattern of lsdPatterns) {
                    const match = html.match(pattern);
                    if (match?.[1]) {
                      lsd = match[1];
                      break;
                    }
                  }

                  const cUserMatch = document.cookie.match(/c_user=(\d+)/);
                  const cUser = cUserMatch ? cUserMatch[1] : fallbackAccountId;
                  if (!cUser) {
                    resolve({ success: false, error: "NO_CUSER", message: "ไม่พบ c_user cookie" });
                    return;
                  }

                  let jazoestSum = 0;
                  for (let i = 0; i < fbDtsg.length; i += 1) {
                    jazoestSum += fbDtsg.charCodeAt(i);
                  }

                  const actualPostId = rawPostId.includes("_")
                    ? rawPostId.split("_")[1]
                    : rawPostId;
                  const pId = pageIdFromCaller || (rawPostId.includes("_") ? rawPostId.split("_")[0] : "");
                  if (!pId || !actualPostId) {
                    resolve({ success: false, error: "INVALID_POST_ID" });
                    return;
                  }
                  const storyId = btoa(`S:_I${pId}:${actualPostId}:${actualPostId}`);

                  const requestVariants = [
                    new URLSearchParams({
                      fb_dtsg: fbDtsg,
                      jazoest: `2${jazoestSum}`,
                      lsd,
                      fb_api_caller_class: "RelayModern",
                      fb_api_req_friendly_name: "CometActivityLogItemCurationMutation",
                      server_timestamps: "true",
                      doc_id: "24411931498505270",
                      variables: JSON.stringify({
                        input: {
                          category_key: "MANAGEPOSTSPHOTOSANDVIDEOS",
                          post_id_str: actualPostId,
                          story_id: storyId,
                          story_location: "ACTIVITY_LOG",
                          structured_error_handling: true,
                          timeline_visibility: "HIDE",
                          actor_id: pId,
                          client_mutation_id: "1",
                        },
                      }),
                    }),
                    new URLSearchParams({
                      av: pId,
                      __user: pId,
                      __a: "1",
                      __comet_req: "15",
                      fb_dtsg: fbDtsg,
                      lsd,
                      jazoest: `2${jazoestSum}`,
                      fb_api_caller_class: "RelayModern",
                      fb_api_req_friendly_name: "CometActivityLogItemCurationMutation",
                      server_timestamps: "true",
                      doc_id: "24411931498505270",
                      variables: JSON.stringify({
                        input: {
                          category_key: "MANAGEPOSTSPHOTOSANDVIDEOS",
                          post_id_str: actualPostId,
                          story_id: storyId,
                          story_location: "ACTIVITY_LOG",
                          structured_error_handling: true,
                          timeline_visibility: "HIDE",
                          actor_id: pId,
                          client_mutation_id: "1",
                        },
                      }),
                    }),
                    new URLSearchParams({
                      av: pId,
                      __user: cUser,
                      __a: "1",
                      __comet_req: "15",
                      fb_dtsg: fbDtsg,
                      lsd,
                      jazoest: `2${jazoestSum}`,
                      fb_api_caller_class: "RelayModern",
                      fb_api_req_friendly_name: "CometActivityLogItemCurationMutation",
                      server_timestamps: "true",
                      doc_id: "24411931498505270",
                      variables: JSON.stringify({
                        input: {
                          category_key: "MANAGEPOSTSPHOTOSANDVIDEOS",
                          post_id_str: actualPostId,
                          story_id: storyId,
                          story_location: "ACTIVITY_LOG",
                          structured_error_handling: true,
                          timeline_visibility: "HIDE",
                          actor_id: pId,
                          client_mutation_id: "1",
                        },
                      }),
                    }),
                  ];

                  const sendVariant = (index) => {
                    if (index >= requestVariants.length) {
                      resolve({
                        success: false,
                        error: "FB_REJECTED",
                        raw: "all hide variants rejected",
                      });
                      return;
                    }

                    const xhr = new XMLHttpRequest();
                    xhr.open("POST", "/api/graphql/");
                    xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
                    xhr.onload = function onload() {
                      const text = stripGraphqlPrefix(xhr.responseText || "");

                      try {
                        const parsed = JSON.parse(text);
                        const curation = parsed?.data?.activity_log_story_curation;

                        if (curation?.success === true) {
                          resolve({ success: true });
                          return;
                        }

                        sendVariant(index + 1);
                      } catch {
                        resolve({
                          success: false,
                          error: "PARSE_ERROR",
                          raw: text.slice(0, 500),
                        });
                      }
                    };
                    xhr.onerror = function onerror() {
                      resolve({ success: false, error: "XHR_ERROR" });
                    };
                    xhr.send(requestVariants[index].toString());
                  };

                  sendVariant(0);
                } catch (error) {
                  resolve({
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                  });
                }
              });
            },
            args: [postId, accountId, explicitPageId],
          });

          const result = results?.[0]?.result || { success: false, error: "No result" };
          if (result?.success) {
            return result;
          }
          lastResult = result;
        }
      }
    } catch (error) {
      lastResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (fallbackTabId) {
        chrome.tabs.remove(fallbackTabId).catch(() => {});
      }
    }
  }

  return lastResult;
}

// ─── Facebook API Proxy ───

async function fbApiRequest(url, method, body, accountId) {
  try {
    await setupDynamicRules(accountId);
    const requestUrl = addAccountMarker(url, accountId);

    const options = {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    };
    if (body && method !== "GET") {
      options.body = body;
      options.headers["Content-Type"] = "application/x-www-form-urlencoded";
    }

    const response = await fetch(requestUrl, options);
    const { data, raw } = await parseJsonLikeResponse(response);

    return {
      data: data ?? { raw },
      status: response.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: 0,
    };
  }
}

async function fbInternalApiRequest(url, method, body, headers = {}, accountId) {
  try {
    if (accountId) {
      await setupDynamicRules(accountId);
    }

    const requestUrl = accountId ? addAccountMarker(url, accountId) : url;
    const options = {
      method,
      headers: { ...headers },
      credentials: "include",
    };

    if (body && method !== "GET") {
      options.body = body;
      if (!headers["Content-Type"]) {
        options.headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }

    const response = await fetch(requestUrl, options);
    const { data, raw } = await parseJsonLikeResponse(response);

    return {
      data: data ?? raw,
      status: response.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: 0,
    };
  }
}

// ─── Photo Upload ───

async function uploadPhoto(accountId, pageId, pageToken, formDataFields, published = true, temporary = false) {
  try {
    await setupDynamicRules(accountId);

    const url = addAccountMarker(
      `https://graph.facebook.com/v22.0/${pageId}/photos?access_token=${pageToken}`,
      accountId
    );
    const formData = new FormData();

    for (const [key, value] of Object.entries(formDataFields)) {
      if (key === "source" && typeof value === "string") {
        formData.append("source", base64ToBlob(value), "photo.jpg");
        continue;
      }

      formData.append(key, value);
    }

    if (!published) formData.append("published", "false");
    if (temporary) formData.append("temporary", "true");

    const response = await fetch(url, {
      method: "POST",
      body: formData,
      credentials: "include",
    });

    const { data, raw } = await parseJsonLikeResponse(response);
    return {
      data: data ?? { raw },
      status: response.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: 0,
    };
  }
}

async function uploadVideo(accountId, adAccountId, userToken, source, title) {
  try {
    await setupDynamicRules(accountId);

    const normalizedAdAccountId = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
    const url = addAccountMarker(
      `https://graph.facebook.com/v22.0/${normalizedAdAccountId}/advideos`,
      accountId
    );
    const formData = new FormData();
    formData.append("access_token", userToken);
    formData.append("source", base64ToBlob(source, "video/mp4"), title || "video.mp4");

    const response = await fetch(url, {
      method: "POST",
      body: formData,
      credentials: "include",
    });

    const { data, raw } = await parseJsonLikeResponse(response);
    return {
      data: data ?? { raw },
      status: response.status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: 0,
    };
  }
}

// ─── Message Handler ───

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ type: "ERROR", error: error.message }));
  return true; // Keep channel open for async
});

async function handleMessage(message) {
  switch (message.type) {
    case "INIT":
      return { type: "INIT", version: VERSION, status: "ok" };

    case "GET_ACCOUNTS":
      return {
        type: "GET_ACCOUNTS",
        accounts: await getAccountsFromCookies(),
      };

    case "GET_COOKIES":
      return {
        type: "GET_COOKIES",
        cookies: await getCookieString(message.accountId),
      };

    case "REFRESH_COOKIES":
      await setupDynamicRules(message.accountId);
      return { type: "REFRESH_COOKIES", success: true };

    case "SET_ACTIVE_ACCOUNT":
      await setupDynamicRules(message.accountId);
      return { type: "SET_ACTIVE_ACCOUNT", success: true };

    case "GET_TOKEN":
      const token = await getToken(
        message.accountId,
        message.forceRefresh || false
      );
      return { type: "GET_TOKEN", token };

    case "GET_FB_DTSG":
      const dtsgResult = await getFbDtsg(message.accountId);
      return { type: "GET_FB_DTSG", ...dtsgResult };

    case "HIDE_POST":
      const hideResult = await hidePost(
        message.postId,
        message.accountId,
        message.pageId
      );
      return { type: "HIDE_POST", ...hideResult };

    case "DELETE_GROUP_POST":
      const deleteGroupResult = await deleteGroupPost(
        message.postId,
        message.groupId,
        message.accountId,
        message.template
      );
      return { type: "DELETE_GROUP_POST", ...deleteGroupResult };

    case "CAPTURE_GROUP_DELETE_REQUEST":
      const captureResult = await captureGroupDeleteRequest(
        message.postId,
        message.groupId,
        message.accountId,
        message.timeoutMs ?? 90000
      );
      return { type: "CAPTURE_GROUP_DELETE_REQUEST", ...captureResult };

    case "CAPTURE_GROUP_SHARE_REQUEST":
      const captureShareResult = await captureGroupShareRequest(
        message.groupId,
        message.accountId,
        message.link,
        message.message ?? "",
        message.timeoutMs ?? 90000
      );
      return { type: "CAPTURE_GROUP_SHARE_REQUEST", ...captureShareResult };

    case "SHARE_GROUP_LINK":
      const shareGroupResult = await shareGroupLinkViaTemplate(
        message.groupId,
        message.accountId,
        message.link,
        message.message ?? "",
        message.template
      );
      return { type: "SHARE_GROUP_LINK", ...shareGroupResult };

    case "SHARE_GROUP_LINK_DIRECT":
      const directShareResult = await shareGroupLinkDirect(
        message.groupId,
        message.accountId,
        message.link,
        message.message ?? ""
      );
      return { type: "SHARE_GROUP_LINK_DIRECT", ...directShareResult };

    case "GET_USER_GROUPS":
      const userGroupsResult = await fetchUserGroups(message.accountId);
      return { type: "GET_USER_GROUPS", ...userGroupsResult };

    case "GET_GROUP_DEBUG_LOG":
      return { type: "GET_GROUP_DEBUG_LOG", entries: getGroupDebugLog() };

    case "RESOLVE_URL":
      try {
        const resolveRes = await fetch(message.url, { method: "HEAD", redirect: "follow" });
        return { type: "RESOLVE_URL", resolvedUrl: resolveRes.url };
      } catch {
        return { type: "RESOLVE_URL", resolvedUrl: message.url };
      }

    case "RESOLVE_URL_BROWSER":
      // Open a real tab to follow ALL redirects including JS redirects
      try {
        const resolvedUrl = await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            chrome.tabs.remove(tabId).catch(() => {});
            reject(new Error("Timeout resolving URL"));
          }, 15000);

          let tabId = -1;
          let lastUrl = message.url;
          let stableCount = 0;

          chrome.tabs.create({ url: message.url, active: false }, (tab) => {
            tabId = tab.id;

            const checkInterval = setInterval(async () => {
              try {
                const currentTab = await chrome.tabs.get(tabId);
                if (currentTab.url && currentTab.url !== lastUrl) {
                  lastUrl = currentTab.url;
                  stableCount = 0;
                } else {
                  stableCount++;
                }

                // URL stable for 3 checks (1.5s) or page fully loaded
                if (stableCount >= 3 || (currentTab.status === "complete" && stableCount >= 1)) {
                  clearInterval(checkInterval);
                  clearTimeout(timeout);
                  chrome.tabs.remove(tabId).catch(() => {});
                  resolve(lastUrl);
                }
              } catch {
                clearInterval(checkInterval);
                clearTimeout(timeout);
                reject(new Error("Tab closed"));
              }
            }, 500);
          });
        });
        return { type: "RESOLVE_URL_BROWSER", resolvedUrl };
      } catch (err) {
        return { type: "RESOLVE_URL_BROWSER", resolvedUrl: message.url, error: err.message };
      }

    case "FB_API":
      const apiResult = await fbApiRequest(
        message.url,
        message.method,
        message.body,
        message.accountId
      );
      return { type: "FB_API", ...apiResult };

    case "FB_INTERNAL_API":
      const internalResult = await fbInternalApiRequest(
        message.url,
        message.method,
        message.body,
        message.headers,
        message.accountId
      );
      return { type: "FB_INTERNAL_API", ...internalResult };

    case "FB_UPLOAD_VIDEO":
      const videoResult = await uploadVideo(
        message.accountId,
        message.adAccountId,
        message.userToken,
        message.source,
        message.title
      );
      return { type: "FB_UPLOAD_VIDEO", ...videoResult };

    case "FB_UPLOAD_PHOTO":
      const photoResult = await uploadPhoto(
        message.accountId,
        message.pageId,
        message.pageToken,
        message.formData,
        message.published ?? true,
        message.temporary ?? false
      );
      return { type: "FB_UPLOAD_PHOTO", ...photoResult };

    default:
      return { type: "ERROR", error: `Unknown message type: ${message.type}` };
  }
}

// ─── Extension Icon Click ───

chrome.action.onClicked.addListener(() => {
  chrome.tabs.query({ url: "*://localhost:3000/*" }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url: "http://localhost:3000" });
    }
  });
});
