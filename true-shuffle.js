/**
 * @name True Shuffle
 * @author egoridxe
 * @version 1.0.0
 * @description Fixes SoundCloud shuffle across entire Liked Tracks, Playlists/Albums, and Radio/Stations instead of only recently loaded tracks.
 * @license MIT
 * @homepage https://github.com/egoridxe/soundcloud-rpc-true-shuffle
 */

const CONFIG = {
    maxCollectionTracks: 5000,
    maxRadioTracks: 300,
    maxFeedTracks: 500,
    apiPageLimit: 200,
    radioPageLimit: 50,
    prefetchCount: 20,
    unshuffleInlineLimit: 50,
    loadTimeoutMs: 25000,
    stallTimeoutMs: 8000,
    legacyFallbackMaxTracks: 2000,
    legacyFallbackBatchSize: 50,
    initRetryIntervalMs: 300,
    initMaxAttempts: 100,
};

function injectedTrueShuffle(CFG) {
    'use strict';

    if (typeof window.__scrpc_cleanup_true_shuffle === 'function') {
        try {
            window.__scrpc_cleanup_true_shuffle();
        } catch (e) {}
    }

    if (window.__trueShuffleLoaded) return;
    window.__trueShuffleLoaded = true;

    var LOG_PREFIX = '[true-shuffle]';
    var STYLE_ID = 'scrpc-true-shuffle-style';

    var lang = String((document.documentElement && document.documentElement.lang) || navigator.language || 'en').toLowerCase();
    var isRu = lang.indexOf('ru') === 0;
    var STRINGS = isRu
        ? {
              shuffleDefault: 'Перемешать',
              loading: function (n) {
                  return 'True Shuffle: загрузка треков (' + n + ')... Нажмите для отмены';
              },
              ready: function (n) {
                  return 'True Shuffle: перемешано ' + n + ' треков';
              },
          }
        : {
              shuffleDefault: 'Shuffle',
              loading: function (n) {
                  return 'True Shuffle: loading tracks (' + n + ')... Click to cancel';
              },
              ready: function (n) {
                  return 'True Shuffle: shuffled ' + n + ' tracks';
              },
          };

    var initTimer = null;
    var initAttempts = 0;
    var disposedPlugin = false;
    var activeShuffleLoads = 0;
    var activeStreams = new Set();
    var pendingSourceContext = null;

    var insideShuffleSetup = false;
    var handledByTrueShuffleStream = false;

    var patchedState = {
        mod390: null,
        orig390: null,
        mod1322: null,
        orig1322: null,
        playManager: null,
        origShuffleSetup: null,
        origShuffleTeardown: null,
        origXhrOpen: null,
        baseCollectionProto: null,
        backboneEvents: null,
        queueCollection: null,
    };

    function log() {
        try {
            var args = [LOG_PREFIX];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            console.log.apply(console, args);
        } catch (e) {}
    }

    function warn() {
        try {
            var args = [LOG_PREFIX];
            for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
            console.warn.apply(console, args);
        } catch (e) {}
    }

    function randomInt(max) {
        if (max <= 1) return 0;
        try {
            if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
                var buf = new Uint32Array(1);
                var limit = Math.floor(0x100000000 / max) * max;
                do {
                    crypto.getRandomValues(buf);
                } while (buf[0] >= limit);
                return buf[0] % max;
            }
        } catch (e) {}
        return Math.floor(Math.random() * max);
    }

    function fisherYatesShuffle(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = randomInt(i + 1);
            var tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
        return arr;
    }

    function ensureStyle() {
        if (document.getElementById(STYLE_ID)) return;
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent =
            '@keyframes scrpc-ts-pulse {' +
            '  0% { opacity: 1; transform: scale(1); }' +
            '  50% { opacity: 0.45; transform: scale(0.92); }' +
            '  100% { opacity: 1; transform: scale(1); }' +
            '}' +
            '.shuffleControl.ts-loading {' +
            '  animation: scrpc-ts-pulse 1s ease-in-out infinite;' +
            '  color: #ff5500 !important;' +
            '  filter: drop-shadow(0 0 4px rgba(255, 85, 0, 0.55));' +
            '}';
        (document.head || document.documentElement).appendChild(style);
    }

    function updateShuffleButtonUI(loading, count, readyTotal) {
        var btn = document.querySelector('.shuffleControl');
        if (!btn) return;
        if (!btn.hasAttribute('data-ts-orig-title')) {
            btn.setAttribute('data-ts-orig-title', btn.getAttribute('title') || STRINGS.shuffleDefault);
        }
        if (loading) {
            ensureStyle();
            btn.classList.add('ts-loading');
            btn.setAttribute('title', STRINGS.loading(count || 0));
        } else {
            btn.classList.remove('ts-loading');
            if (typeof readyTotal === 'number' && readyTotal > 0) {
                btn.setAttribute('title', STRINGS.ready(readyTotal));
            } else {
                var origTitle = btn.getAttribute('data-ts-orig-title');
                if (origTitle !== null) btn.setAttribute('title', origTitle);
            }
        }
    }

    function clearShuffleButtonUI() {
        var btn = document.querySelector('.shuffleControl');
        if (btn) {
            btn.classList.remove('ts-loading');
            var origTitle = btn.getAttribute('data-ts-orig-title');
            if (origTitle !== null) {
                btn.setAttribute('title', origTitle);
                btn.removeAttribute('data-ts-orig-title');
            }
        }
        var style = document.getElementById(STYLE_ID);
        if (style) style.remove();
    }

    function createFallbackEvents() {
        return {
            on: function (name, cb, ctx) {
                if (!cb) return this;
                this._tsEvents = this._tsEvents || {};
                var list = (this._tsEvents[name] = this._tsEvents[name] || []);
                list.push({ cb: cb, ctx: ctx || this });
                return this;
            },
            once: function (name, cb, ctx) {
                var self = this;
                function wrapper() {
                    self.off(name, wrapper);
                    cb.apply(this, arguments);
                }
                wrapper._origCb = cb;
                return this.on(name, wrapper, ctx);
            },
            off: function (name, cb, ctx) {
                if (!this._tsEvents) return this;
                if (!name && !cb && !ctx) {
                    this._tsEvents = {};
                    return this;
                }
                var names = name ? [name] : Object.keys(this._tsEvents);
                for (var i = 0; i < names.length; i++) {
                    var n = names[i];
                    var list = this._tsEvents[n];
                    if (!list) continue;
                    if (!cb && !ctx) {
                        delete this._tsEvents[n];
                        continue;
                    }
                    var remaining = [];
                    for (var j = 0; j < list.length; j++) {
                        var entry = list[j];
                        var cbMatch = !cb || entry.cb === cb || entry.cb._origCb === cb;
                        var ctxMatch = !ctx || entry.ctx === ctx;
                        if (!(cbMatch && ctxMatch)) remaining.push(entry);
                    }
                    if (remaining.length) this._tsEvents[n] = remaining;
                    else delete this._tsEvents[n];
                }
                return this;
            },
            trigger: function (name) {
                if (!this._tsEvents || !this._tsEvents[name]) return this;
                var args = Array.prototype.slice.call(arguments, 1);
                var list = this._tsEvents[name].slice();
                for (var i = 0; i < list.length; i++) {
                    list[i].cb.apply(list[i].ctx, args);
                }
                return this;
            },
        };
    }

    function attachEvents(target) {
        if (patchedState.backboneEvents) {
            return Object.assign(target, patchedState.backboneEvents);
        }
        return Object.assign(target, createFallbackEvents());
    }

    function findWebpackRequire() {
        var uniqueKey = '__ts_' + Date.now() + '_' + Math.random().toString(36).slice(2);
        if (Array.isArray(window.webpackJsonp) || (window.webpackJsonp && typeof window.webpackJsonp.push === 'function')) {
            try {
                var reqFunc = null;
                var modDef = {};
                modDef[uniqueKey] = function (module, exports, __webpack_require__) {
                    reqFunc = __webpack_require__;
                };
                window.webpackJsonp.push([[], modDef, [[uniqueKey]]]);
                if (reqFunc) return reqFunc;
            } catch (e) {}
        }
        var keys = Object.keys(window);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            if (key.indexOf('webpackChunk') === 0) {
                var chunk = window[key];
                if (Array.isArray(chunk)) {
                    try {
                        var chunkReq = null;
                        var chunkDef = {};
                        chunkDef[uniqueKey] = function (module, exports, __webpack_require__) {
                            chunkReq = __webpack_require__;
                        };
                        chunk.push([[uniqueKey], chunkDef, [[uniqueKey]]]);
                        if (chunkReq) return chunkReq;
                    } catch (e) {}
                }
            }
        }
        return null;
    }

    function discoverModules(wpRequire) {
        var cache = wpRequire && wpRequire.c;
        if (!cache) return null;

        var res = {
            playManager: null,
            mod390: null,
            mod1322: null,
            baseCollectionProto: null,
            backboneEvents: null,
        };

        var ids = Object.keys(cache);
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var mod = cache[id];
            if (!mod) continue;
            var exp;
            try {
                exp = mod.exports;
            } catch (e) {
                continue;
            }
            if (!exp) continue;

            if (
                !res.playManager &&
                typeof exp === 'object' &&
                typeof exp.toggleShuffle === 'function' &&
                typeof exp.getQueue === 'function' &&
                typeof exp.playSource === 'function' &&
                typeof exp.pullNext === 'function' &&
                typeof exp.hasMoreAhead === 'function' &&
                exp.states &&
                exp.states.shuffle &&
                typeof exp.states.shuffle.setup === 'function'
            ) {
                res.playManager = exp;
            }

            if (typeof exp === 'function') {
                if (!res.mod390) {
                    try {
                        var src390 = Function.prototype.toString.call(exp);
                        if (
                            src390.indexOf('getCurrentSound') !== -1 &&
                            src390.indexOf('createSoundFilter') !== -1 &&
                            src390.indexOf('contextSnapshot') !== -1
                        ) {
                            res.mod390 = mod;
                        }
                    } catch (e) {}
                }

                if (!res.mod1322) {
                    try {
                        var src1322 = Function.prototype.toString.call(exp);
                        if (
                            src1322.indexOf('excludeStartingSound') !== -1 &&
                            src1322.indexOf('unshuffle') !== -1 &&
                            src1322.indexOf('Math.random') !== -1
                        ) {
                            res.mod1322 = mod;
                        }
                    } catch (e) {}
                }

                if (
                    !res.baseCollectionProto &&
                    exp.prototype &&
                    exp.prototype.defaults &&
                    exp.prototype.defaults.maxPageSize !== undefined &&
                    typeof exp.prototype.isFullyPopulated === 'function' &&
                    typeof exp.prototype.setLimit === 'function'
                ) {
                    res.baseCollectionProto = exp.prototype;
                }
            }

            if (
                !res.backboneEvents &&
                typeof exp === 'object' &&
                exp.Events &&
                typeof exp.Events.on === 'function' &&
                exp.Collection &&
                exp.Model
            ) {
                res.backboneEvents = exp.Events;
            }
        }

        if (res.playManager && res.mod390 && res.mod1322) {
            return res;
        }
        return null;
    }

    function getSourceUrlString(source) {
        if (!source) return '';
        try {
            if (typeof source.next_href === 'string' && source.next_href) return source.next_href;
            if (typeof source.baseUrl === 'function') return String(source.baseUrl() || '');
            if (typeof source.baseUrl === 'string') return source.baseUrl;
            if (typeof source.url === 'function') return String(source.url() || '');
            if (typeof source.url === 'string') return source.url;
        } catch (e) {}
        return '';
    }

    function classifySource(source, origRandomBufferSize) {
        if (!source) {
            return { source: null, kind: 'unknown', poolCap: CFG.maxCollectionTracks, bumpLimit: false };
        }
        var rtype = source.resource_type;
        if (rtype === 'playlist') {
            return { source: source, kind: 'playlist', poolCap: CFG.maxCollectionTracks, bumpLimit: false };
        }
        if (rtype === 'system-playlist') {
            return { source: source, kind: 'station', poolCap: CFG.maxCollectionTracks, bumpLimit: false };
        }

        var urlStr = getSourceUrlString(source);
        if (origRandomBufferSize === 1 || urlStr.indexOf('/related') !== -1) {
            return { source: source, kind: 'radio', poolCap: CFG.maxRadioTracks, bumpLimit: false };
        }

        if (/\/(track_likes|likes|tracks|reposts|playlists)(\b|\/|\?|$)/.test(urlStr)) {
            return { source: source, kind: 'collection', poolCap: CFG.maxCollectionTracks, bumpLimit: true };
        }

        if (typeof source.isFullyPopulated === 'function' && typeof source.setLimit === 'function') {
            return { source: source, kind: 'feed', poolCap: CFG.maxFeedTracks, bumpLimit: true };
        }

        return { source: source, kind: 'unknown', poolCap: CFG.maxCollectionTracks, bumpLimit: false };
    }

    function patchXHR() {
        if (!window.XMLHttpRequest || !window.XMLHttpRequest.prototype) return;
        var proto = window.XMLHttpRequest.prototype;
        if (patchedState.origXhrOpen) return;

        var origOpen = proto.open;
        patchedState.origXhrOpen = origOpen;

        proto.open = function (method, url) {
            var args = Array.prototype.slice.call(arguments);
            if (activeShuffleLoads > 0 && typeof url === 'string' && url.indexOf('api') !== -1) {
                try {
                    var parsed = new URL(url, window.location.origin);
                    var host = parsed.hostname || '';
                    if (
                        (host === 'api-v2.soundcloud.com' || host === 'api.soundcloud.com') &&
                        parsed.pathname.indexOf('/related') === -1 &&
                        /\/(track_likes|likes|tracks|playlists|reposts|favorites)(\b|\/|\?|$)/.test(parsed.pathname)
                    ) {
                        var currentLimit = parsed.searchParams.get('limit');
                        if (currentLimit !== null) {
                            var numericLimit = parseInt(currentLimit, 10);
                            if (!isNaN(numericLimit) && numericLimit < CFG.apiPageLimit) {
                                parsed.searchParams.set('limit', String(CFG.apiPageLimit));
                                args[1] = parsed.toString();
                            }
                        }
                    }
                } catch (e) {}
            }
            return origOpen.apply(this, args);
        };
    }

    function bumpSourceLimit(sourceCtx) {
        if (!sourceCtx || !sourceCtx.bumpLimit || !sourceCtx.source) return;
        var src = sourceCtx.source;
        try {
            if (src.options && typeof src.options.maxPageSize === 'number') {
                src.options.maxPageSize = Math.max(src.options.maxPageSize, CFG.apiPageLimit);
            }
            if (typeof src.setLimit === 'function') {
                var curLimit = (src.options && src.options.limit) || 0;
                if (curLimit < CFG.apiPageLimit) {
                    src.setLimit(CFG.apiPageLimit);
                }
            }
        } catch (e) {}
    }

    function createEnhancedDualStream(sourceStream, startSound, mapFn, randomBufferSize, startIndex, soundFilter, opts) {
        var ctx = pendingSourceContext || {
            source: null,
            kind: randomBufferSize === 1 ? 'radio' : 'collection',
            poolCap: randomBufferSize === 1 ? CFG.maxRadioTracks : CFG.maxCollectionTracks,
            bumpLimit: false,
        };

        var fn = typeof mapFn === 'function' ? mapFn : function (x) { return x; };
        var filterFn = typeof soundFilter === 'function' ? soundFilter : function () { return true; };
        var excludeStart = !!(opts && opts.excludeStartingSound);
        var startIdx = typeof startIndex === 'number' ? startIndex : 0;

        var bufferTarget = 1;
        var poolCap = ctx.poolCap || CFG.maxCollectionTracks;
        var isShuffled = false;

        var foundStart = false;
        var emitStartFirst = !excludeStart && !!startSound && !!filterFn(startSound);
        var startItem = null;
        var nextIdx = startIdx;

        var prevBuf = [];
        var pool = [];
        var emittedCount = 0;

        var nextPaused = true;
        var nextEnded = false;
        var prevPaused = true;
        var prevEnded = false;
        var disposed = false;

        var forceReady = false;
        var capReached = false;
        var isBufferingAll = false;
        var holdingGlobalLock = false;
        var loadTimer = null;
        var stallTimer = null;
        var lastDataTime = 0;

        var startPromise = null;
        var resolveStartFn = null;

        function setGlobalLoadState(active) {
            if (active && !holdingGlobalLock) {
                holdingGlobalLock = true;
                activeShuffleLoads++;
            } else if (!active && holdingGlobalLock) {
                holdingGlobalLock = false;
                if (activeShuffleLoads > 0) activeShuffleLoads--;
            }
        }

        function clearTimers() {
            if (loadTimer) {
                clearTimeout(loadTimer);
                loadTimer = null;
            }
            if (stallTimer) {
                clearTimeout(stallTimer);
                stallTimer = null;
            }
        }

        function stopBufferingState(showReadyCount) {
            clearTimers();
            if (isBufferingAll) {
                isBufferingAll = false;
                setGlobalLoadState(false);
                if (showReadyCount) {
                    updateShuffleButtonUI(false, 0, pool.length + emittedCount);
                } else {
                    updateShuffleButtonUI(false, 0);
                }
            }
        }

        function resetStallTimer() {
            if (!isBufferingAll || disposed) return;
            if (stallTimer) clearTimeout(stallTimer);
            lastDataTime = Date.now();
            stallTimer = setTimeout(function () {
                if (disposed || !isBufferingAll) return;
                warn('Stream stalled after', CFG.stallTimeoutMs, 'ms at', pool.length, 'tracks; shuffling loaded pool.');
                forceReady = true;
                stopBufferingState(true);
                drainNext();
            }, CFG.stallTimeoutMs);
        }

        function startBufferingState() {
            if (disposed || isBufferingAll) return;
            isBufferingAll = true;
            forceReady = false;
            setGlobalLoadState(true);
            bumpSourceLimit(ctx);
            updateShuffleButtonUI(true, pool.length);

            loadTimer = setTimeout(function () {
                if (disposed || !isBufferingAll) return;
                warn('Load timeout reached after', CFG.loadTimeoutMs, 'ms at', pool.length, 'tracks.');
                forceReady = true;
                stopBufferingState(true);
                drainNext();
            }, CFG.loadTimeoutMs);

            resetStallTimer();
        }

        function mergePrevIntoPool() {
            if (!prevBuf.length) return;
            while (prevBuf.length) {
                pool.push(prevBuf.shift());
            }
        }

        function toQueueItem(entry) {
            if (entry.prebuilt) return entry.prebuilt;
            return fn(entry);
        }

        function popNextEntry() {
            if (!pool.length) return null;
            if (!isShuffled) {
                return pool.shift();
            }
            if (pool.length === 1) {
                return pool.pop();
            }
            var idx = randomInt(pool.length);
            var picked = pool[idx];
            var last = pool.pop();
            if (idx < pool.length) {
                pool[idx] = last;
            }
            return picked;
        }

        function emitEntry(entry) {
            var queueItem = toQueueItem(entry);
            emittedCount++;
            nextStream.trigger('data', queueItem);
            if (entry.prebuilt && typeof entry.prebuilt.release === 'function') {
                entry.prebuilt.release();
                entry.prebuilt = null;
            }
        }

        function ensureStart() {
            if (!startPromise) {
                startPromise = new Promise(function (resolve) {
                    resolveStartFn = resolve;

                    sourceStream.on('data', function (sound, metadata) {
                        if (disposed) return;
                        var valid = !!filterFn(sound, metadata);

                        if (!foundStart && startSound && sound !== startSound) {
                            if (valid) {
                                prevBuf.push({ sound: sound, metadata: metadata });
                            }
                            return;
                        }

                        if (!foundStart) {
                            foundStart = true;
                            sourceStream.pause();
                            for (var k = 0; k < prevBuf.length; k++) {
                                prevBuf[k].index = k - prevBuf.length;
                            }
                            if (valid && !excludeStart) {
                                var item = { sound: sound, index: nextIdx++, metadata: metadata };
                                if (emitStartFirst) startItem = item;
                                pool.push(item);
                            }
                            resolve();
                            return;
                        }

                        if (valid) {
                            pool.push({ sound: sound, index: nextIdx++, metadata: metadata });
                            if (isBufferingAll) {
                                updateShuffleButtonUI(true, pool.length);
                                if (Date.now() - lastDataTime >= 100) {
                                    resetStallTimer();
                                }
                            }
                            if (!isShuffled || pool.length >= bufferTarget || forceReady) {
                                drainNext();
                            }
                        }
                    });

                    sourceStream.on('end', function () {
                        if (disposed) return;
                        if (!foundStart) {
                            foundStart = true;
                            for (var k = 0; k < prevBuf.length; k++) {
                                prevBuf[k].index = nextIdx++;
                                pool.push(prevBuf[k]);
                            }
                            prevBuf.length = 0;
                            resolve();
                        }
                        if (isBufferingAll) {
                            stopBufferingState(true);
                        }
                        if (!nextEnded && pool.length === 0) {
                            nextEnded = true;
                            nextStream.trigger('end');
                        } else {
                            drainNext();
                        }
                    });
                });
            }
            if (!foundStart) {
                sourceStream.resume();
            }
            return startPromise;
        }

        function drainNext() {
            if (disposed || nextPaused) return;

            if (isShuffled && prevBuf.length) {
                mergePrevIntoPool();
            }

            if (emitStartFirst && startItem) {
                emitStartFirst = false;
                var startPos = pool.indexOf(startItem);
                if (startPos !== -1) pool.splice(startPos, 1);
                var toEmitStart = startItem;
                startItem = null;
                emitEntry(toEmitStart);
                if (nextPaused || disposed) return;
            }

            if (isShuffled && pool.length >= bufferTarget) {
                capReached = true;
            }
            if (capReached && pool.length <= Math.floor(bufferTarget * 0.5)) {
                capReached = false;
            }

            var canDrainPool = !isShuffled || sourceStream.isEnded() || pool.length >= bufferTarget || capReached || forceReady;

            if (canDrainPool) {
                if (isBufferingAll) {
                    stopBufferingState(true);
                }
                while (!nextPaused && !disposed && pool.length > 0 && (!isShuffled || sourceStream.isEnded() || pool.length >= bufferTarget || capReached || forceReady)) {
                    var picked = popNextEntry();
                    if (picked) emitEntry(picked);
                    if (isShuffled && pool.length <= Math.floor(bufferTarget * 0.5)) {
                        capReached = false;
                    }
                }
            }

            if (disposed) return;

            if (sourceStream.isEnded()) {
                if (!nextEnded && pool.length === 0) {
                    nextEnded = true;
                    nextStream.trigger('end');
                }
            } else if (!nextPaused && !nextEnded) {
                if (isShuffled && pool.length < bufferTarget && !capReached && !forceReady) {
                    startBufferingState();
                }
                sourceStream.resume();
            }
        }

        var nextStream = attachEvents({
            __trueShuffle: true,

            shuffle: function () {
                if (disposed) return;
                handledByTrueShuffleStream = true;
                isShuffled = true;
                bufferTarget = poolCap;
                forceReady = false;
                capReached = false;

                mergePrevIntoPool();

                if (insideShuffleSetup && patchedState.playManager) {
                    var pm = patchedState.playManager;
                    var queue = pm.getQueue && pm.getQueue();
                    var state = pm.getQueueState && pm.getQueueState();
                    var cursor = state && typeof state.currentIndex === 'number' ? state.currentIndex : -1;

                    var needsRequeue = !sourceStream.isEnded() || pool.length > 0 || prevBuf.length > 0;
                    if (needsRequeue && queue && cursor >= 0) {
                        var afterCursor = queue.slice(cursor + 1);
                        var autoItems = [];
                        for (var i = 0; i < afterCursor.length; i++) {
                            var qi = afterCursor[i];
                            if (qi && !qi.explicit) autoItems.push(qi);
                        }
                        if (autoItems.length) {
                            for (var j = 0; j < autoItems.length; j++) {
                                var item = autoItems[j];
                                if (typeof item.hold === 'function') item.hold();
                                item.order = null;
                                pool.push({
                                    prebuilt: item,
                                    index: typeof item.index === 'number' ? item.index : nextIdx++,
                                    sound: item.sound,
                                });
                            }
                            if (typeof queue.remove === 'function') {
                                queue.remove(autoItems);
                            }
                        }
                        setTimeout(function () {
                            if (disposed || !isShuffled) return;
                            try {
                                if (pm.getState && pm.getState('shuffle') && typeof pm.pullNext === 'function') {
                                    pm.pullNext(CFG.prefetchCount);
                                }
                            } catch (e) {}
                        }, 0);
                    }
                }
            },

            unshuffle: function () {
                stopBufferingState(false);
                isShuffled = false;
                bufferTarget = 1;
                forceReady = false;
                capReached = false;

                var negItems = [];
                var posItems = [];
                for (var i = 0; i < pool.length; i++) {
                    var item = pool[i];
                    if (typeof item.index === 'number' && item.index < 0) {
                        negItems.push(item);
                    } else {
                        posItems.push(item);
                    }
                }
                pool.length = 0;

                if (negItems.length) {
                    negItems.sort(function (a, b) {
                        return (a.index || 0) - (b.index || 0);
                    });
                    for (var k = 0; k < negItems.length; k++) {
                        prevBuf.push(negItems[k]);
                    }
                    prevEnded = false;
                    prevPaused = true;
                }

                posItems.sort(function (a, b) {
                    return (a.index || 0) - (b.index || 0);
                });

                var inlineEntries;
                if (posItems.length > CFG.unshuffleInlineLimit) {
                    inlineEntries = posItems.slice(0, CFG.unshuffleInlineLimit);
                    pool = posItems.slice(CFG.unshuffleInlineLimit);
                } else {
                    inlineEntries = posItems;
                }

                var prebuiltToRelease = [];
                var mapped = [];
                for (var m = 0; m < inlineEntries.length; m++) {
                    var entry = inlineEntries[m];
                    if (entry.prebuilt) {
                        prebuiltToRelease.push(entry.prebuilt);
                        mapped.push(entry.prebuilt);
                        entry.prebuilt = null;
                    } else {
                        mapped.push(fn(entry));
                    }
                }

                if (prebuiltToRelease.length) {
                    var releaseBatch = function () {
                        for (var r = 0; r < prebuiltToRelease.length; r++) {
                            try {
                                if (typeof prebuiltToRelease[r].release === 'function') {
                                    prebuiltToRelease[r].release();
                                }
                            } catch (e) {}
                        }
                    };
                    if (typeof Promise === 'function') {
                        Promise.resolve().then(releaseBatch);
                    } else {
                        setTimeout(releaseBatch, 0);
                    }
                }

                return mapped;
            },

            absorbRemainingQueueItems: function (items) {
                for (var i = 0; i < items.length; i++) {
                    var item = items[i];
                    if (typeof item.hold === 'function') item.hold();
                    item.order = null;
                    pool.push({
                        prebuilt: item,
                        index: typeof item.index === 'number' ? item.index : nextIdx++,
                        sound: item.sound,
                    });
                }
            },

            pause: function () {
                nextPaused = true;
                if (foundStart) {
                    sourceStream.pause();
                }
            },

            peek: function () {
                return sourceStream.peek();
            },

            resume: function () {
                nextPaused = false;
                ensureStart().then(drainNext);
            },

            isEnded: function () {
                return sourceStream.isEnded() && pool.length === 0;
            },
        });

        var prevStream = attachEvents({
            pause: function () {
                prevPaused = true;
            },

            resume: function () {
                if (!prevPaused) return;
                prevPaused = false;
                ensureStart().then(function () {
                    while (!prevPaused && !disposed && prevBuf.length) {
                        var entry = prevBuf.pop();
                        if (entry) {
                            var qi = toQueueItem(entry);
                            prevStream.trigger('data', qi);
                            if (entry.prebuilt && typeof entry.prebuilt.release === 'function') {
                                entry.prebuilt.release();
                                entry.prebuilt = null;
                            }
                        }
                    }
                    if (!prevEnded && prevBuf.length === 0) {
                        prevEnded = true;
                        prevPaused = true;
                        prevStream.trigger('end');
                    }
                });
            },

            isEnded: function () {
                return prevEnded;
            },
        });

        var controller = {
            next: nextStream,
            prev: prevStream,
            isShuffledCtrl: function () {
                return !disposed && isShuffled;
            },
            deactivatePlugin: function () {
                if (disposed) return;
                stopBufferingState(false);
                poolCap = 1;
                if (isShuffled) {
                    bufferTarget = 1;
                    forceReady = true;
                    drainNext();
                }
            },
            dispose: function () {
                disposed = true;
                stopBufferingState(false);
                activeStreams.delete(controller);

                for (var i = 0; i < pool.length; i++) {
                    if (pool[i] && pool[i].prebuilt && typeof pool[i].prebuilt.release === 'function') {
                        try {
                            pool[i].prebuilt.release();
                        } catch (e) {}
                        pool[i].prebuilt = null;
                    }
                }
                for (var j = 0; j < prevBuf.length; j++) {
                    if (prevBuf[j] && prevBuf[j].prebuilt && typeof prevBuf[j].prebuilt.release === 'function') {
                        try {
                            prevBuf[j].prebuilt.release();
                        } catch (e) {}
                        prevBuf[j].prebuilt = null;
                    }
                }
                pool.length = 0;
                prevBuf.length = 0;

                if (resolveStartFn) {
                    try {
                        resolveStartFn();
                    } catch (e) {}
                }

                try { prevStream.off(); } catch (e) {}
                try { nextStream.off(); } catch (e) {}
                try { sourceStream.dispose(); } catch (e) {}
            },
        };

        activeStreams.add(controller);
        return controller;
    }

    async function fallbackPumpLegacyQueue(pm) {
        var queue = pm.getQueue && pm.getQueue();
        if (!queue) return;

        var startTime = Date.now();
        var stalled = 0;
        var lastLen = queue.length;
        activeShuffleLoads++;
        updateShuffleButtonUI(true, queue.length);

        try {
            while (!disposedPlugin && pm.getState && pm.getState('shuffle')) {
                if (!pm.hasMoreAhead || !pm.hasMoreAhead()) break;
                if (queue.length >= CFG.legacyFallbackMaxTracks) break;
                if (Date.now() - startTime >= CFG.loadTimeoutMs) break;

                try {
                    pm.pullNext(CFG.legacyFallbackBatchSize);
                } catch (e) {
                    break;
                }

                await new Promise(function (resolve) {
                    setTimeout(resolve, 150);
                });

                if (queue.length > lastLen) {
                    lastLen = queue.length;
                    stalled = 0;
                    updateShuffleButtonUI(true, lastLen);
                } else {
                    stalled++;
                    if (stalled >= 33) break;
                }
            }

            if (!disposedPlugin && pm.getState && pm.getState('shuffle')) {
                var state = pm.getQueueState && pm.getQueueState();
                var cursor = state && typeof state.currentIndex === 'number' ? state.currentIndex : -1;
                if (cursor >= -1 && queue.length > cursor + 2) {
                    var head = queue.slice(0, cursor + 1);
                    var tail = queue.slice(cursor + 1);
                    var explicitItems = [];
                    var autoItems = [];
                    for (var i = 0; i < tail.length; i++) {
                        if (tail[i] && tail[i].explicit) explicitItems.push(tail[i]);
                        else autoItems.push(tail[i]);
                    }
                    fisherYatesShuffle(autoItems);
                    if (typeof queue.reset === 'function') {
                        queue.reset(head.concat(explicitItems, autoItems));
                    }
                }
                updateShuffleButtonUI(false, 0, queue.length);
            } else {
                updateShuffleButtonUI(false, 0);
            }
        } finally {
            if (activeShuffleLoads > 0) activeShuffleLoads--;
        }
    }

    function applyPatches(modules) {
        var pm = modules.playManager;
        patchedState.playManager = pm;
        patchedState.backboneEvents = modules.backboneEvents;
        patchedState.baseCollectionProto = modules.baseCollectionProto;

        if (patchedState.baseCollectionProto && patchedState.baseCollectionProto.defaults) {
            if (typeof patchedState.baseCollectionProto.defaults.maxPageSize === 'number') {
                patchedState.baseCollectionProto.defaults.maxPageSize = Math.max(
                    patchedState.baseCollectionProto.defaults.maxPageSize,
                    CFG.apiPageLimit
                );
            }
        }

        if (!patchedState.mod390) {
            patchedState.mod390 = modules.mod390;
            patchedState.orig390 = modules.mod390.exports;
            modules.mod390.exports = function (source, startSound, contextSnapshot, randomBufferSize, startIndex, opts) {
                var classified = classifySource(source, randomBufferSize);
                pendingSourceContext = classified;
                try {
                    return patchedState.orig390.apply(this, arguments);
                } finally {
                    pendingSourceContext = null;
                }
            };
        }

        if (!patchedState.mod1322) {
            patchedState.mod1322 = modules.mod1322;
            patchedState.orig1322 = modules.mod1322.exports;
            modules.mod1322.exports = function (sourceStream, startSound, mapFn, randomBufferSize, startIndex, soundFilter, opts) {
                return createEnhancedDualStream(sourceStream, startSound, mapFn, randomBufferSize, startIndex, soundFilter, opts);
            };
        }

        if (pm.states && pm.states.shuffle) {
            if (!patchedState.origShuffleSetup) {
                patchedState.origShuffleSetup = pm.states.shuffle.setup;
                pm.states.shuffle.setup = function () {
                    insideShuffleSetup = true;
                    handledByTrueShuffleStream = false;
                    var result;
                    try {
                        result = patchedState.origShuffleSetup.apply(this, arguments);
                    } finally {
                        insideShuffleSetup = false;
                    }
                    if (!handledByTrueShuffleStream && pm.hasMoreAhead && pm.hasMoreAhead()) {
                        fallbackPumpLegacyQueue(pm);
                    }
                    return result;
                };
            }

            if (!patchedState.origShuffleTeardown) {
                patchedState.origShuffleTeardown = pm.states.shuffle.teardown;
                pm.states.shuffle.teardown = function () {
                    var queue = pm.getQueue && pm.getQueue();
                    var state = pm.getQueueState && pm.getQueueState();
                    var cursor = state && typeof state.currentIndex === 'number' ? state.currentIndex : -1;

                    if (queue && cursor >= 0 && activeStreams.size > 0) {
                        var afterCursor = queue.slice(cursor + 1);
                        var nonExplicitToAbsorb = [];
                        for (var i = 0; i < afterCursor.length; i++) {
                            var qi = afterCursor[i];
                            if (qi && !qi.explicit && qi.order == null) {
                                nonExplicitToAbsorb.push(qi);
                            }
                        }
                        if (nonExplicitToAbsorb.length) {
                            activeStreams.forEach(function (ctrl) {
                                if (
                                    nonExplicitToAbsorb.length &&
                                    ctrl &&
                                    typeof ctrl.isShuffledCtrl === 'function' &&
                                    ctrl.isShuffledCtrl() &&
                                    ctrl.next &&
                                    typeof ctrl.next.absorbRemainingQueueItems === 'function'
                                ) {
                                    ctrl.next.absorbRemainingQueueItems(nonExplicitToAbsorb);
                                    if (typeof queue.remove === 'function') {
                                        queue.remove(nonExplicitToAbsorb);
                                    }
                                    nonExplicitToAbsorb = [];
                                }
                            });
                        }
                    }

                    updateShuffleButtonUI(false, 0);
                    return patchedState.origShuffleTeardown.apply(this, arguments);
                };
            }
        }

        patchXHR();
        log('Patched SoundCloud modules successfully.');
    }

    function tryInitialize() {
        if (disposedPlugin) return true;
        var wpRequire = findWebpackRequire();
        if (!wpRequire) return false;
        var modules = discoverModules(wpRequire);
        if (!modules) return false;
        applyPatches(modules);
        return true;
    }

    if (!tryInitialize()) {
        initTimer = setInterval(function () {
            initAttempts++;
            if (tryInitialize() || initAttempts >= CFG.initMaxAttempts) {
                clearInterval(initTimer);
                initTimer = null;
                if (initAttempts >= CFG.initMaxAttempts && !patchedState.playManager) {
                    warn('Timed out waiting for SoundCloud webpack modules.');
                }
            }
        }, CFG.initRetryIntervalMs);
    }

    window.__scrpc_cleanup_true_shuffle = function () {
        disposedPlugin = true;
        if (initTimer) {
            clearInterval(initTimer);
            initTimer = null;
        }

        activeStreams.forEach(function (ctrl) {
            try {
                if (ctrl && typeof ctrl.deactivatePlugin === 'function') {
                    ctrl.deactivatePlugin();
                }
            } catch (e) {}
        });
        activeStreams.clear();
        activeShuffleLoads = 0;

        if (patchedState.mod390 && patchedState.orig390) {
            patchedState.mod390.exports = patchedState.orig390;
        }
        if (patchedState.mod1322 && patchedState.orig1322) {
            patchedState.mod1322.exports = patchedState.orig1322;
        }
        if (patchedState.playManager && patchedState.playManager.states && patchedState.playManager.states.shuffle) {
            if (patchedState.origShuffleSetup) {
                patchedState.playManager.states.shuffle.setup = patchedState.origShuffleSetup;
            }
            if (patchedState.origShuffleTeardown) {
                patchedState.playManager.states.shuffle.teardown = patchedState.origShuffleTeardown;
            }
        }
        if (patchedState.origXhrOpen && window.XMLHttpRequest && window.XMLHttpRequest.prototype) {
            window.XMLHttpRequest.prototype.open = patchedState.origXhrOpen;
        }

        clearShuffleButtonUI();
        delete window.__trueShuffleLoaded;
        delete window.__scrpc_cleanup_true_shuffle;
        log('Cleaned up plugin.');
    };
}

module.exports = {
    onEnable() {
        console.log('True Shuffle plugin enabled');
    },

    onDisable() {
        console.log('True Shuffle plugin disabled');
    },

    contentScript() {
        return '(' + injectedTrueShuffle.toString() + ')(' + JSON.stringify(CONFIG) + ');';
    },
};
