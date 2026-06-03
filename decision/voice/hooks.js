/**
 * hooks.js — Voice trigger hooks for Communication Layer v2
 * voice/hooks.js
 *
 * Loads settings from /voice/settings.json, then registers window.voiceHooks
 * so that dashboard.js can fire voice triggers when new outbox entries arrive.
 *
 * Exposes:
 *   window.voiceHooks = {
 *     onNewOutbox(entry)      → called by dashboard.js on new outbox entry
 *   }
 *   window.voiceSettings = { autoRead, rate, lang, pitch, voice }
 *
 * Controls (callable from browser console or UI):
 *   voiceHooks.mute()         → stop + mute
 *   voiceHooks.unmute()       → re-enable auto-read
 *   voiceHooks.speakEntry(e)  → force-speak a specific entry
 */

(function () {
  'use strict';

  // ── Defaults (overridden by settings.json) ─────────────────
  const SETTINGS_URL = '/voice/settings.json';

  let settings = {
    autoRead: true,
    rate:     1.0,
    pitch:    1.0,
    lang:     'de-DE',
    voice:    'default',
  };

  // ── Load settings.json ─────────────────────────────────────
  async function loadSettings() {
    try {
      const r = await fetch(SETTINGS_URL);
      if (!r.ok) return;
      const data = await r.json();
      settings = Object.assign(settings, data);
      window.voiceSettings = settings;
    } catch {
      // Server might not be running yet; use defaults silently.
    }
  }

  // ── Speak a MessageEntry ────────────────────────────────────
  function speakEntry(entry) {
    if (!window.VoiceReader) return;
    window.VoiceReader.speak(entry.text, {
      topic: entry.topic,
      rate:  settings.rate,
      pitch: settings.pitch,
      lang:  settings.lang,
    });
  }

  // ── voiceHooks API ──────────────────────────────────────────
  const voiceHooks = {
    /**
     * Called by dashboard.js whenever a genuinely new outbox entry arrives.
     * Only speaks if autoRead is enabled and VoiceReader is not muted.
     */
    onNewOutbox(entry) {
      if (!settings.autoRead)              return;
      if (window.VoiceReader?.isMuted())   return;
      speakEntry(entry);
    },

    speakEntry,

    mute() {
      settings.autoRead = false;
      window.VoiceReader?.mute();
      console.info('[voice] Muted.');
    },

    unmute() {
      settings.autoRead = true;
      window.VoiceReader?.unmute();
      console.info('[voice] Unmuted.');
    },

    /** Manually read the last N outbox entries (useful after page reload). */
    readLast(n = 1) {
      if (!window.VoiceReader) return;
      const outbox = window.state?.outbox ?? [];
      const entries = outbox.slice(-n);
      for (const entry of entries) speakEntry(entry);
    },

    /** Update a setting at runtime and persist to window.voiceSettings. */
    set(key, value) {
      settings[key] = value;
      window.voiceSettings = settings;
      if (key === 'rate')  window.VoiceReader?.setRate(value);
      if (key === 'lang')  window.VoiceReader?.setLang(value);
    },

    getSettings() { return { ...settings }; },
  };

  window.voiceHooks    = voiceHooks;
  window.voiceSettings = settings;   // initial defaults; overwritten after fetch

  // ── Init: load settings and set up voice reader ─────────────
  loadSettings().then(() => {
    // Sync loaded settings into VoiceReader if it's already initialised
    if (window.VoiceReader) {
      window.VoiceReader.setRate(settings.rate);
      window.VoiceReader.setLang(settings.lang);
    }
  });

  // Re-export controls to console for easy debugging
  console.info('[voice] hooks.js loaded. window.voiceHooks ready.');
  console.info('[voice] Commands: voiceHooks.mute() / unmute() / readLast(n) / set("rate", 0.9)');

})();
