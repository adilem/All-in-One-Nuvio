var forge = require('node-forge');

var PROVIDER_NAME = "Peachify";
var AES_KEY_HEX = "a8f2a1b5e9c470814f6b2c3a5d8e7f9c1a2b3c4d5e3f7a8b8cad1e2d0a4d5c5b";
var KEY_BYTES = forge.util.hexToBytes(AES_KEY_HEX);
var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
var TIMEOUT = 15000;

// Array of different proxy servers. Iron/Dark are currently the most stable.
// Wolf has been removed as its Cloudflare worker blocks the native Android TV player.
var SERVERS = [
  { label: "Iron",  base: "https://uwu.eat-peach.sbs", path: "moviebox" },
  { label: "Spider", base: "https://usa.eat-peach.sbs", path: "holly" },
  { label: "Multi", base: "https://usa.eat-peach.sbs", path: "multi" },
  { label: "Dark",  base: "https://uwu.eat-peach.sbs", path: "net" }
];

var REQUEST_HEADERS = {
  "User-Agent": UA,
  "Origin": "https://peachify.top",
  "Referer": "https://peachify.top/"
};

function b64urlDecode(s) {
    let t = s.replace(/-/g, "+").replace(/_/g, "/");
    let padding = t.length % 4 === 0 ? "" : "=".repeat(4 - t.length % 4);
    return forge.util.decode64(t + padding);
}

function aesGcmDecrypt(encryptedStr) {
    const parts = encryptedStr.split(".");
    if (parts.length < 3) return null;
    
    const iv = b64urlDecode(parts[0]);
    const c1 = b64urlDecode(parts[1]);
    const c2 = b64urlDecode(parts[2]);
    
    const combined = c1 + c2;
    const actual_ciphertext = combined.substring(0, combined.length - 16);
    const tag = combined.substring(combined.length - 16);
    
    const decipher = forge.cipher.createDecipher('AES-GCM', KEY_BYTES);
    
    decipher.start({
        iv: iv,
        tagLength: 128,
        tag: forge.util.createBuffer(tag)
    });
    
    decipher.update(forge.util.createBuffer(actual_ciphertext));
    const pass = decipher.finish();
    
    if (pass) {
        try {
            return JSON.parse(decipher.output.toString('utf8'));
        } catch(e) {
            return null;
        }
    } else {
        return null;
    }
}

async function fetchWithTimeout(url, options, timeout) {
  timeout = timeout || TIMEOUT;
  try {
    var signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout)
      ? AbortSignal.timeout(timeout) : null;
    var merged = { ...(options || {}) };
    if (signal) merged.signal = signal;
    return await fetch(url, merged);
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError')
      console.log("[" + PROVIDER_NAME + "] Timeout: " + url.substring(0, 80));
    return null;
  }
}

async function fetchFromServer(server, tmdbId, mediaType, season, episode) {
  var typePath = (mediaType === 'tv' || mediaType === 'series') ? 'tv' : 'movie';
  var url = server.base + "/" + server.path + "/" + typePath + "/" + tmdbId;
  if ((mediaType === 'tv' || mediaType === 'series') && season != null && episode != null)
    url += "/" + season + "/" + episode;

  console.log("[" + PROVIDER_NAME + "] " + server.label + ": " + url.substring(0, 100));

  var res = await fetchWithTimeout(url, { headers: REQUEST_HEADERS }, TIMEOUT);
  if (!res || !res.ok) {
    console.log("[" + PROVIDER_NAME + "] " + server.label + " -> " + (res ? res.status : "no response"));
    return null;
  }

  var json = await res.json();
  if (!json || !json.isEncrypted || !json.data) {
    console.log("[" + PROVIDER_NAME + "] " + server.label + " unexpected format");
    return null;
  }

  var decrypted = aesGcmDecrypt(json.data);
  if (!decrypted) {
    console.log("[" + PROVIDER_NAME + "] " + server.label + " decrypt fail");
    return null;
  }

  var count = decrypted.sources ? decrypted.sources.length : 0;
  console.log("[" + PROVIDER_NAME + "] " + server.label + " OK (" + count + " sources)");
  return decrypted;
}

function normalizeQuality(q) {
  var t = String(q || '').toLowerCase();
  if (t.indexOf('2160') >= 0 || t.indexOf('4k') >= 0) return '2160p';
  if (t.indexOf('1080') >= 0) return '1080p';
  if (t.indexOf('720') >= 0) return '720p';
  if (t.indexOf('480') >= 0) return '480p';
  return 'HD';
}

function buildStreams(data, serverLabel) {
  var streams = [];
  var seen = {};
  if (!data || !data.sources) return streams;

  for (var i = 0; i < data.sources.length; i++) {
    var src = data.sources[i];
    var url = src.url || src.src || src.file || src.stream || src.streamUrl || '';
    if (!url || seen[url]) continue;
    seen[url] = true;

    var dub = src.dub || src.audio || src.language || src.name || 'Original';
    var quality = normalizeQuality(src.quality || src.resolution || '');
    var label = serverLabel + ' | ' + quality + ' | ' + dub;

    var reqHeaders = {
      "Referer": "https://peachify.top/",
      "User-Agent": UA
    };
    
    if (src.headers) {
        for (var k in src.headers) {
            reqHeaders[k] = src.headers[k];
        }
    }

    var isHls = url.indexOf('m3u8') !== -1;
    var streamObj = {
      name: label,
      title: label + '\n' + quality + ' · ' + dub,
      url: url,
      quality: quality,
      behaviorHints: {
        notWebReady: true
      }
    };

    if (isHls) {
      // HLS playlists natively handle redirects, requires native ExoPlayer headers
      streamObj.headers = reqHeaders;
    } else {
      // Direct MP4s or Cloudflare workers require proxyHeaders
      streamObj.behaviorHints.proxyHeaders = { request: reqHeaders };
    }

    streams.push(streamObj);
  }

  return streams;
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    console.log("[" + PROVIDER_NAME + "] ID=" + tmdbId + " T=" + mediaType + " S=" + season + " E=" + episode);

    var idStr = String(tmdbId || '').trim();
    if (idStr.indexOf('tt') === 0) {
      console.log("[" + PROVIDER_NAME + "] Resolving IMDb ID...");
      var tmdbRes = await fetchWithTimeout(
        "https://api.themoviedb.org/3/find/" + idStr + "?api_key=439c478a771f35c05022f9feabcca01c&external_source=imdb_id",
        { headers: { "User-Agent": UA } }, 10000
      );
      if (tmdbRes && tmdbRes.ok) {
        var tmdbData = await tmdbRes.json();
        var results = (mediaType === 'tv' || mediaType === 'series') ? tmdbData.tv_results : tmdbData.movie_results;
        if (results && results.length > 0) {
          idStr = String(results[0].id);
          console.log("[" + PROVIDER_NAME + "] Resolved to TMDB: " + idStr);
        }
      }
    }

    var serverTasks = SERVERS.map(function(s) {
      return (async function() {
        var data = await fetchFromServer(s, idStr, mediaType, season, episode);
        return data ? buildStreams(data, s.label) : [];
      })();
    });

    var results = await Promise.all(serverTasks);
    var allStreams = [];
    for (var r = 0; r < results.length; r++) {
      for (var i = 0; i < results[r].length; i++)
        allStreams.push(results[r][i]);
    }

    console.log("[" + PROVIDER_NAME + "] Total: " + allStreams.length + " streams");
    return allStreams;

  } catch (e) {
    console.error("[" + PROVIDER_NAME + "] Fatal: " + (e.message || e));
    return [];
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}
