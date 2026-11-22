/* Shared first-paint and interactive appearance preferences. No account data. */
(function (host) {
  'use strict';
  if (host.__NF_HUB_APPEARANCE__) return;
  var key = 'nf-hub:appearance:v1';
  var defaults = Object.freeze({ scheme: 'auto', oled: false, sidebar: false });
  function normalize(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...defaults };
    return {
      scheme: value.scheme === 'light' || value.scheme === 'dark' ? value.scheme : 'auto',
      oled: typeof value.oled === 'boolean' ? value.oled : false,
      sidebar: typeof value.sidebar === 'boolean' ? value.sidebar : false
    };
  }
  function parse(raw) {
    try { return normalize(typeof raw === 'string' && raw.length <= 1024 ? JSON.parse(raw) : null); }
    catch (_) { return { ...defaults }; }
  }
  function storage(target) {
    try { return target.localStorage; } catch (_) { return null; }
  }
  function read(target) {
    try { return parse(storage(target).getItem(key)); } catch (_) { return { ...defaults }; }
  }
  function resolve(preferences, systemDark) {
    var dark = preferences.scheme === 'dark' || (preferences.scheme === 'auto' && systemDark);
    return dark ? (preferences.oled ? 'oled' : 'dark') : 'light';
  }
  function media(target) {
    try { return target.matchMedia('(prefers-color-scheme: dark)'); } catch (_) { return null; }
  }
  function createStore(target) {
    var preferences = read(target), query = media(target), subscribers = new Set(), detachMedia = null;
    var snapshot;
    function publish() {
      var theme = resolve(preferences, !!(query && query.matches));
      if (snapshot && snapshot.scheme === preferences.scheme && snapshot.oled === preferences.oled && snapshot.sidebar === preferences.sidebar && snapshot.theme === theme) return;
      snapshot = Object.freeze({ ...preferences, theme: theme, dark: theme !== 'light' });
      if (target.document) {
        var root = target.document.documentElement;
        root.setAttribute('data-scheme', preferences.scheme);
        root.setAttribute('data-theme', theme);
        var color = target.document.querySelector('meta[name="theme-color"]');
        if (color) color.setAttribute('content', theme === 'oled' ? '#000000' : theme === 'dark' ? '#242424' : '#f4f7f8');
        var nativeScheme = target.document.querySelector('meta[name="color-scheme"]');
        if (nativeScheme) nativeScheme.setAttribute('content', theme === 'light' ? 'light' : 'dark');
      }
      subscribers.forEach(function (listener) { listener(); });
    }
    function syncMedia() {
      if (detachMedia) detachMedia();
      detachMedia = null;
      query = media(target);
      if (!subscribers.size || preferences.scheme !== 'auto' || !query) return;
      var current = query;
      var change = function () { if (preferences.scheme === 'auto') publish(); };
      if (current.addEventListener) {
        current.addEventListener('change', change);
        detachMedia = function () { current.removeEventListener('change', change); };
      } else if (current.addListener) {
        current.addListener(change);
        detachMedia = function () { current.removeListener(change); };
      }
    }
    function onStorage(event) {
      if (event.key !== key) return;
      preferences = parse(event.newValue);
      syncMedia();
      publish();
    }
    publish();
    return Object.freeze({
      getSnapshot: function () { return snapshot; },
      subscribe: function (listener) {
        subscribers.add(listener);
        if (subscribers.size === 1) {
          // Catch system changes since first paint without discarding in-memory preferences.
          syncMedia();
          if (target.addEventListener) target.addEventListener('storage', onStorage);
          publish();
        }
        return function () {
          subscribers.delete(listener);
          if (!subscribers.size) {
            if (detachMedia) detachMedia();
            detachMedia = null;
            if (target.removeEventListener) target.removeEventListener('storage', onStorage);
          }
        };
      },
      setPreferences: function (patch) {
        preferences = normalize({ ...preferences, ...patch });
        try { storage(target).setItem(key, JSON.stringify(preferences)); } catch (_) { /* In-memory preferences remain available. */ }
        syncMedia();
        publish();
      }
    });
  }
  host.__NF_HUB_APPEARANCE__ = Object.freeze({ key: key, defaults: defaults, normalize: normalize, parse: parse, resolve: resolve, createStore: createStore, store: createStore(host) });
})(globalThis);
