/**
 * reader.js — Browser Text-to-Speech engine for Communication Layer v2
 * voice/reader.js
 *
 * Exposes window.VoiceReader — a managed speech queue that prevents
 * overlapping utterances and respects the current voice settings.
 *
 * API:
 *   VoiceReader.speak(text, { topic, lang, rate, pitch })
 *   VoiceReader.stop()
 *   VoiceReader.mute()      → pauses auto-read; manual speak still works
 *   VoiceReader.unmute()
 *   VoiceReader.setRate(n)  → 0.5 – 2.0, persisted to settings
 *   VoiceReader.setLang(s)  → e.g. 'de-DE', 'en-US'
 *   VoiceReader.isSpeaking() → bool
 *   VoiceReader.isMuted()    → bool
 *
 * Settings are read from window.voiceSettings (set by hooks.js).
 * Falls back to built-in defaults if Speech API is unavailable.
 */

(function () {
  'use strict';

  // ── Defaults ───────────────────────────────────────────────
  const DEFAULTS = {
    lang:     'de-DE',
    rate:     1.0,
    pitch:    1.0,
    autoRead: true,
  };

  // ── Internal state ─────────────────────────────────────────
  let _muted   = false;
  let _queue   = [];         // string[] of plain text waiting to be spoken
  let _current = null;       // SpeechSynthesisUtterance | null
  let _onDone  = null;       // callback fired after each utterance

  // ── Markdown stripper (same logic as dashboard.js) ─────────
  function stripMarkdown(text) {
    return text
      .replace(/```[\s\S]*?```/g, '(code block)')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^>\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // ── Settings accessor ──────────────────────────────────────
  function settings() {
    return Object.assign({}, DEFAULTS, window.voiceSettings ?? {});
  }

  // ── Speak one item from the queue ──────────────────────────
  function _drainQueue() {
    if (_queue.length === 0) { _current = null; return; }
    if (!('speechSynthesis' in window)) return;

    const rawText = _queue.shift();
    const s       = settings();

    const u   = new SpeechSynthesisUtterance(rawText);
    u.lang    = s.lang;
    u.rate    = Math.max(0.5, Math.min(2.0, s.rate));
    u.pitch   = Math.max(0.5, Math.min(2.0, s.pitch));

    // Pick preferred voice if available
    const voices = speechSynthesis.getVoices();
    if (voices.length > 0 && s.voice && s.voice !== 'default') {
      const preferred = voices.find(v => v.name === s.voice || v.voiceURI === s.voice);
      if (preferred) u.voice = preferred;
    }

    _current = u;

    u.onend   = () => { _current = null; _drainQueue(); if (_onDone) _onDone(); };
    u.onerror = () => { _current = null; _drainQueue(); };

    speechSynthesis.speak(u);
  }

  // ── Public API ─────────────────────────────────────────────
  const VoiceReader = {

    /**
     * Queue text for speech.
     * @param {string} text  - Raw text (Markdown will be stripped).
     * @param {object} [opts] - { topic, lang, rate, pitch }
     */
    speak(text, opts = {}) {
      if (!('speechSynthesis' in window)) return;

      const clean = stripMarkdown(text);
      const label = opts.topic ? `Topic: ${opts.topic}. ` : '';
      const full  = `${label}${clean}`;

      // Apply per-call overrides temporarily via a custom object instead of
      // mutating global settings.  Simplest: just create the utterance inline.
      if (Object.keys(opts).some(k => k === 'lang' || k === 'rate' || k === 'pitch')) {
        const s = settings();
        const u = new SpeechSynthesisUtterance(full);
        u.lang  = opts.lang  ?? s.lang;
        u.rate  = opts.rate  ?? s.rate;
        u.pitch = opts.pitch ?? s.pitch;
        _current = u;
        u.onend   = () => { _current = null; _drainQueue(); };
        u.onerror = () => { _current = null; _drainQueue(); };
        speechSynthesis.cancel();   // clear anything already playing
        speechSynthesis.speak(u);
        return;
      }

      _queue.push(full);
      if (!_current) _drainQueue();
    },

    /** Stop current speech and clear queue. */
    stop() {
      _queue = [];
      _current = null;
      if ('speechSynthesis' in window) speechSynthesis.cancel();
    },

    /** Mute: stop current speech and prevent further auto-reads. */
    mute() {
      _muted = true;
      this.stop();
      document.dispatchEvent(new CustomEvent('voiceReader:muted'));
    },

    unmute() {
      _muted = false;
      document.dispatchEvent(new CustomEvent('voiceReader:unmuted'));
    },

    isMuted()   { return _muted; },
    isSpeaking() {
      return 'speechSynthesis' in window && speechSynthesis.speaking;
    },

    /** Update rate and persist to window.voiceSettings. */
    setRate(rate) {
      window.voiceSettings = Object.assign({}, window.voiceSettings ?? {}, { rate });
    },

    /** Update lang and persist to window.voiceSettings. */
    setLang(lang) {
      window.voiceSettings = Object.assign({}, window.voiceSettings ?? {}, { lang });
    },

    /**
     * Register a callback fired after each utterance completes.
     * Used by hooks.js to chain sequential reads.
     */
    onDone(fn) { _onDone = fn; },

    /** Return available voices (browser-dependent). */
    voices() {
      return 'speechSynthesis' in window ? speechSynthesis.getVoices() : [];
    },
  };

  window.VoiceReader = VoiceReader;

})();
