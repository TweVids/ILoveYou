/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback } from 'react';

// Upload with a hard timeout so one hung POST can never block later frames.
const postWithTimeout = (url: string, init: RequestInit, ms = 6000) => {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  const outer = init.signal as AbortSignal | undefined;
  if (outer) {
    if (outer.aborted) c.abort();
    else outer.addEventListener('abort', () => c.abort(), { once: true });
  }
  return fetch(url, { ...init, signal: c.signal }).finally(() => clearTimeout(t));
};

export default function App() {
  const [inCall, setInCall] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Settings states
  const [cameraOn, setCameraOn] = useState(() => {
    try {
      return localStorage.getItem('streamer_camera') !== 'false';
    } catch {
      return true;
    }
  });
  const [recorderOn, setRecorderOn] = useState(() => {
    try {
      return localStorage.getItem('streamer_recorder') !== 'false';
    } catch {
      return true;
    }
  });
  const [provider, setProvider] = useState<'localhost' | 'server'>(() => {
    try {
      return (localStorage.getItem('streamer_provider') as 'localhost' | 'server') || 'localhost';
    } catch {
      return 'localhost';
    }
  });
  const [hostInput, setHostInput] = useState(() => {
    try {
      return localStorage.getItem('streamer_host') || 'http://localhost:8000';
    } catch {
      return 'http://localhost:8000';
    }
  });
  const [endpointInput, setEndpointInput] = useState(() => {
    try {
      return localStorage.getItem('streamer_endpoint') || 'https://api.server.com';
    } catch {
      return 'https://api.server.com';
    }
  });

  // Streaming refs
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const nextPlayTimeRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Hold-to-record voice message refs and state
  const [isRecordingVoice, setIsRecordingVoice] = useState(false);
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedVoiceChunksRef = useRef<Blob[]>([]);

  // Incoming Opus streaming refs
  const mediaSourceRef = useRef<MediaSource | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const audioElemRef = useRef<HTMLAudioElement | null>(null);
  const chunkQueueRef = useRef<Uint8Array[]>([]);

  // Screen capture & tool action refs
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const isSendingScreenRef = useRef(false);
  const [isSharingDeviceScreen, setIsSharingDeviceScreen] = useState(false);

  // Visual feedback state for executed UI tool actions
  const [actionFeedback, setActionFeedback] = useState<{
    id: number;
    action: string;
    x: number;
    y: number;
    x2?: number;
    y2?: number;
    text?: string;
  } | null>(null);

  // Connection check state (for settings modal)
  const [connectionCheck, setConnectionCheck] = useState<{
    status: 'idle' | 'checking' | 'success' | 'error';
    message: string | null;
    pingMs: number | null;
  }>({
    status: 'idle',
    message: null,
    pingMs: null,
  });

  // Network and streaming activity status
  const [netState, setNetState] = useState<{
    status: 'idle' | 'connecting' | 'ok' | 'error';
    lastError: string | null;
    imgCount: number;
    audioCount: number;
    screenCount: number;
    uiActionCount: number;
  }>({
    status: 'idle',
    lastError: null,
    imgCount: 0,
    audioCount: 0,
    screenCount: 0,
    uiActionCount: 0,
  });

  // Native Android accessibility service status (for system-wide control across all apps)
  const [accessibilityStatus, setAccessibilityStatus] = useState<{
    available: boolean;
    enabled: boolean;
    canScreenshot: boolean;
  }>({
    available: false,
    enabled: false,
    canScreenshot: false,
  });
  const accessibilityEnabledRef = useRef(false);

  // Latest UI state, read through a ref so the stream effect does NOT restart
  // every time an action flashes feedback / settings open / mic toggles.
  const uiRef = useRef({ cameraOn, isRecordingVoice, isSettingsOpen, actionFeedback });
  uiRef.current = { cameraOn, isRecordingVoice, isSettingsOpen, actionFeedback };
  const screenBusySinceRef = useRef(0);
  // Debug telemetry (shown on the PC console as "[phone] ...")
  const lastScreenOkRef = useRef(Date.now());
  const capPendingRef = useRef(0);
  const lastCapMsRef = useRef(0);

  const checkDeviceControlStatus = useCallback(async () => {
    const DeviceControl = (window as unknown as { Capacitor?: { Plugins?: { DeviceControl?: { checkStatus: () => Promise<any> } } } }).Capacitor?.Plugins?.DeviceControl;
    if (DeviceControl && typeof DeviceControl.checkStatus === 'function') {
      try {
        const res = await DeviceControl.checkStatus();
        const isEnabled = Boolean(res?.accessibilityEnabled);
        accessibilityEnabledRef.current = isEnabled;
        setAccessibilityStatus({
          available: true,
          enabled: isEnabled,
          canScreenshot: Boolean(res?.canTakeSystemScreenshot),
        });

        // If native streaming foreground service is already active in background, auto-restore inCall UI!
        if (Boolean(res?.foregroundServiceRunning)) {
          console.log('[NativeService] Foreground service already active, auto-reconnecting call session UI');
          setInCall(true);
        }
        return res;
      } catch (e) {
        console.warn('[DeviceControl] Status check failed:', e);
      }
    }
    return null;
  }, []);

  const handleOpenAccessibilitySettings = useCallback(async () => {
    const DeviceControl = (window as unknown as { Capacitor?: { Plugins?: { DeviceControl?: { openAccessibilitySettings: () => Promise<any> } } } }).Capacitor?.Plugins?.DeviceControl;
    if (DeviceControl && typeof DeviceControl.openAccessibilitySettings === 'function') {
      try {
        await DeviceControl.openAccessibilitySettings();
      } catch (e) {
        console.warn('[DeviceControl] Failed opening accessibility settings:', e);
      }
    } else {
      alert('Accessibility settings can only be opened when running the APK on an Android device.');
    }
  }, []);

  // NEW: explicitly stop the always-on background service.
  const handleStopSystemControl = useCallback(async () => {
    const DeviceControl = (window as unknown as { Capacitor?: { Plugins?: { DeviceControl?: { stopService?: () => Promise<any> } } } }).Capacitor?.Plugins?.DeviceControl;
    if (DeviceControl && typeof DeviceControl.stopService === 'function') {
      try {
        await DeviceControl.stopService();
      } catch (e) {
        console.warn('[DeviceControl] Failed stopping service:', e);
      }
    }
  }, []);

  // Poll accessibility status on mount and when settings open
  useEffect(() => {
    checkDeviceControlStatus();
  }, [checkDeviceControlStatus, isSettingsOpen]);

  // NEW: refresh accessibility status when the app regains focus (e.g. after
  // the user toggles Accessibility in Android Settings and comes back).
  useEffect(() => {
    const refresh = () => { checkDeviceControlStatus(); };
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', refresh);
    };
  }, [checkDeviceControlStatus]);

  // Compute base URL for current provider
  const getBaseUrl = useCallback(() => {
    let base = provider === 'localhost' ? hostInput.trim() : endpointInput.trim();
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      base = `http://${base}`;
    }
    return base.replace(/\/+$/, '');
  }, [provider, hostInput, endpointInput]);
  const getBaseUrlRef = useRef(getBaseUrl);
  getBaseUrlRef.current = getBaseUrl;

  // Save settings and test connection
  const handleSaveAndCheckConnection = useCallback(async () => {
    try {
      localStorage.setItem('streamer_provider', provider);
      localStorage.setItem('streamer_host', hostInput);
      localStorage.setItem('streamer_endpoint', endpointInput);
    } catch {
      // Ignore storage errors
    }

    const targetUrl = getBaseUrl();
    setConnectionCheck({ status: 'checking', message: `Checking ${targetUrl}...`, pingMs: null });

    const startTime = performance.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);

      const res = await fetch(`${targetUrl}/v1/audio/sent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ping: true }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const pingMs = Math.round(performance.now() - startTime);

      if (res.status === 200 || res.status === 400) {
        setConnectionCheck({
          status: 'success',
          message: `Connected successfully! (HTTP ${res.status})`,
          pingMs,
        });
      } else {
        setConnectionCheck({
          status: 'error',
          message: `Server reachable but returned HTTP ${res.status} (${res.statusText})`,
          pingMs,
        });
      }
    } catch (err: unknown) {
      const msg = (err as Error)?.message || 'Connection failed';
      setConnectionCheck({
        status: 'error',
        message: msg.includes('abort')
          ? 'Timed out (4s). Check IP & firewall on port 8000.'
          : msg.includes('Failed to fetch')
          ? 'Failed to fetch. Server not running, wrong IP, or CORS missing.'
          : msg,
        pingMs: null,
      });
    }
  }, [provider, hostInput, endpointInput, getBaseUrl]);

  // Start holding mic: record user speech
  const startVoiceRecording = useCallback(() => {
    if (!inCall || !recorderOn || !mediaStreamRef.current) return;
    const audioTracks = mediaStreamRef.current.getAudioTracks();
    if (audioTracks.length === 0 || typeof MediaRecorder === 'undefined') return;

    try {
      const audioStream = new MediaStream(audioTracks);
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find(
        (type) => MediaRecorder.isTypeSupported(type)
      ) || '';

      const recorder = new MediaRecorder(audioStream, mimeType ? { mimeType } : undefined);
      recordedVoiceChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recordedVoiceChunksRef.current.push(event.data);
        }
      };

      recorder.onstop = async () => {
        const chunks = recordedVoiceChunksRef.current;
        recordedVoiceChunksRef.current = [];
        if (chunks.length === 0) return;

        const voiceBlob = new Blob(chunks, { type: mimeType || 'audio/webm;codecs=opus' });
        if (voiceBlob.size === 0) return;

        const baseUrl = getBaseUrl();
        const audioTarget = `${baseUrl}/v1/audio/sent`;
        try {
          console.log(`[Voice Record] Sending complete voice file: ${voiceBlob.size} bytes (${voiceBlob.type})`);
          const res = await fetch(audioTarget, {
            method: 'POST',
            headers: { 'Content-Type': voiceBlob.type || 'audio/webm;codecs=opus' },
            body: voiceBlob,
            signal: abortControllerRef.current?.signal,
          });
          if (res.ok) {
            console.log(`[Audio Sent] ${res.status} OK - whole file ${voiceBlob.size} bytes`);
            setNetState((prev) => ({
              ...prev,
              status: 'ok',
              lastError: null,
              audioCount: prev.audioCount + 1,
            }));
          } else {
            const errorMsg = `Audio HTTP ${res.status}`;
            console.warn(`[Audio Sent Error] ${errorMsg}`);
            setNetState((prev) => ({
              ...prev,
              status: 'error',
              lastError: errorMsg,
            }));
          }
        } catch (err: unknown) {
          if (!abortControllerRef.current?.signal.aborted) {
            const msg = (err as Error)?.message || 'Audio network error';
            console.error('[Audio Sent Failed]', msg);
            setNetState((prev) => ({
              ...prev,
              status: 'error',
              lastError: msg.includes('Failed to fetch') ? 'Connection Failed (Check IP/CORS)' : msg,
            }));
          }
        }
      };

      recorder.start();
      voiceRecorderRef.current = recorder;
      setIsRecordingVoice(true);
    } catch (err) {
      console.error('Failed to start voice recording:', err);
    }
  }, [inCall, recorderOn, getBaseUrl]);

  // Release mic: stop recording and automatically send whole audio file
  const stopVoiceRecording = useCallback(() => {
    if (voiceRecorderRef.current && voiceRecorderRef.current.state === 'recording') {
      try {
        voiceRecorderRef.current.stop();
      } catch {
        // Ignore
      }
      voiceRecorderRef.current = null;
    }
    setIsRecordingVoice(false);
  }, []);

  // Web Audio fallback player for individual chunks
  const playAudioChunk = useCallback(async (arrayBuffer: ArrayBuffer) => {
    if (!audioContextRef.current) {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      audioContextRef.current = new AudioCtx();
    }
    const ctx = audioContextRef.current;
    if (ctx.state === 'suspended') {
      await ctx.resume();
    }

    try {
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);

      const currentTime = ctx.currentTime;
      const startTime = Math.max(currentTime, nextPlayTimeRef.current);
      source.start(startTime);
      nextPlayTimeRef.current = startTime + audioBuffer.duration;
    } catch {
      // Ignore individual decode errors
    }
  }, []);

  // Stop incoming audio player cleanly
  const stopAudioPlayer = useCallback(() => {
    if (audioElemRef.current) {
      audioElemRef.current.pause();
      audioElemRef.current.removeAttribute('src');
      audioElemRef.current.load();
      if (audioElemRef.current.parentNode) {
        audioElemRef.current.parentNode.removeChild(audioElemRef.current);
      }
      audioElemRef.current = null;
    }
    sourceBufferRef.current = null;
    mediaSourceRef.current = null;
    chunkQueueRef.current = [];

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    nextPlayTimeRef.current = 0;
  }, []);

  // Listen to /v2/audio/retrived and play Opus stream in real-time queue
  const startAudioReceiver = useCallback((baseUrl: string, signal: AbortSignal) => {
    const listenEndpoint = `${baseUrl}/v2/audio/retrived`;

    const pollOrStream = async () => {
      try {
        console.log(`[Audio Receiver] Connecting to ${listenEndpoint}...`);
        const response = await fetch(listenEndpoint, { signal, headers: { 'ngrok-skip-browser-warning': '1' }, });
        if (!response.ok || !response.body) {
          console.warn(`[Audio Receiver] Stream response: ${response.status} ${response.statusText}`);
          return;
        }
        console.log('[Audio Receiver] Stream connected');

        // ---- pick the best codec the browser supports ----
        const supportedType = typeof MediaSource !== 'undefined' && [
          'audio/webm; codecs="opus"',
          'audio/ogg; codecs="opus"',
          'audio/webm',
        ].find((type) => MediaSource.isTypeSupported(type));

        if (!supportedType) {
          console.error('[Audio Receiver] MediaSource not supported in this browser. Aborting.');
          return;
        }
        console.log('[Audio Receiver] Using codec:', supportedType);

        let useMediaSource = false;

        const ms = new MediaSource();
        const audio = new Audio();
        audio.autoplay = true;
        (audio as unknown as { playsInline: boolean }).playsInline = true;
        audio.style.display = 'none';
        document.body.appendChild(audio);
        audio.src = URL.createObjectURL(ms);
        audioElemRef.current = audio;
        mediaSourceRef.current = ms;

        ms.addEventListener('sourceopen', () => console.log('[MSE] sourceopen'));
        ms.addEventListener('sourceclose', () => console.warn('[MSE] sourceclose'));
        ms.addEventListener('sourceended', () => console.warn('[MSE] sourceended'));
        audio.addEventListener('error', () => console.error('[audio] error', (audio as unknown as { error: unknown }).error));
        audio.addEventListener('stalled', () => console.warn('[audio] stalled'));
        audio.addEventListener('waiting', () => console.warn('[audio] waiting'));
        audio.addEventListener('playing', () => console.log('[audio] playing'));
        audio.addEventListener('timeupdate', () => {
          const customAudio = audio as unknown as { _lastT?: number };
          if (Math.floor(audio.currentTime) !== Math.floor(customAudio._lastT || -1)) {
            customAudio._lastT = audio.currentTime;
            console.log(
              '[audio] t=',
              audio.currentTime.toFixed(2),
              'readyState=',
              audio.readyState,
              'buffered=',
              audio.buffered.length,
              'paused=',
              audio.paused
            );
          }
        });

        await new Promise<void>((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
          };

          ms.addEventListener(
            'sourceopen',
            () => {
              try {
                const sb = ms.addSourceBuffer(supportedType);
                sourceBufferRef.current = sb;

                sb.addEventListener('error', (e) => {
                  console.error('[MSE] SourceBuffer error', e);
                });
                sb.addEventListener('updateend', () => {
                  if (chunkQueueRef.current.length > 0 && !sb.updating) {
                    const next = chunkQueueRef.current.shift();
                    if (next) {
                      try {
                        sb.appendBuffer(next);
                      } catch (e) {
                        console.error('[MSE] appendBuffer failed', e);
                      }
                    }
                  }
                  if (
                    audioElemRef.current &&
                    audioElemRef.current.paused &&
                    audioElemRef.current.buffered.length > 0
                  ) {
                    audioElemRef.current.play().catch((e) =>
                      console.warn('[audio] play() rejected:', e)
                    );
                  }
                });

                useMediaSource = true;
                audio
                  .play()
                  .then(() => console.log('[audio] play() resolved'))
                  .catch((e) => console.warn('[audio] play() rejected:', e));

                console.log('[Audio Receiver] MediaSource ready, codec=', supportedType);
              } catch (e) {
                console.error('[Audio Receiver] addSourceBuffer failed', e);
              }
              finish();
            },
            { once: true }
          );

          setTimeout(() => {
            if (!settled) {
              console.error('[Audio Receiver] sourceopen timeout — MSE did not initialise');
              finish();
            }
          }, 5000);
        });

        if (!useMediaSource) {
          console.error('[Audio Receiver] MediaSource failed to initialise. Aborting receiver.');
          return;
        }

        // ---- read the stream ----
        const reader = response.body.getReader();
        let totalBytes = 0;
        let totalChunks = 0;
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value || value.byteLength === 0) continue;

          totalChunks += 1;
          totalBytes += value.byteLength;
          if (totalChunks % 20 === 1) {
            console.log(
              `[Audio Receiver] chunk ${totalChunks}, ${value.byteLength} B (total ${totalBytes} B)`
            );
          }

          const sb = sourceBufferRef.current;
          if (!sb) continue;

          if (sb.updating || chunkQueueRef.current.length > 0) {
            chunkQueueRef.current.push(value);
          } else {
            try {
              sb.appendBuffer(value);
            } catch (e) {
              console.warn('[MSE] direct append failed, queued:', e);
              chunkQueueRef.current.push(value);
            }
          }
        }

        console.warn(
          '[Audio Receiver] reader loop ended after',
          totalChunks,
          'chunks /',
          totalBytes,
          'bytes'
        );
      } catch (err) {
        if (!signal.aborted) {
          console.warn('[Audio Receiver] stream error:', err);
          setTimeout(() => {
            if (!signal.aborted) pollOrStream();
          }, 2000);
        }
      }
    };

    pollOrStream();
  }, []);

  // Find closest scrollable container for stroll actions
  const findScrollableParent = (el: Element | null): Element | Window => {
    let curr = el;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      const style = window.getComputedStyle(curr);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const isScrollableY =
        (overflowY === 'auto' || overflowY === 'scroll') && curr.scrollHeight > curr.clientHeight;
      const isScrollableX =
        (overflowX === 'auto' || overflowX === 'scroll') && curr.scrollWidth > curr.clientWidth;
      if (isScrollableY || isScrollableX) {
        return curr;
      }
      curr = curr.parentElement;
    }
    return window;
  };

  // Execute normalized UI tool action (click, stroll, type) on real DOM dimensions
  const executeUiAction = useCallback((params: {
    action: string;
    x1: number;
    y1: number;
    x2?: number;
    y2?: number;
    scroll_speed?: number;
    scroll_duration_ms?: number;
    text?: string;
    press_enter?: boolean;
  }) => {
    const width = window.innerWidth || 360;
    const height = window.innerHeight || 640;

    // Normalized coordinates (0-999) mapped back to real screen/DOM dimensions
    const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));
    const realX1 = clamp((params.x1 / 999) * width, 0, width);
    const realY1 = clamp((params.y1 / 999) * height, 0, height);

    const realX2 =
      params.x2 !== undefined ? clamp((params.x2 / 999) * width, 0, width) : realX1;
    const realY2 =
      params.y2 !== undefined ? clamp((params.y2 / 999) * height, 0, height) : realY1;

    console.log(
      `[UI Action] "${params.action}" at (${Math.round(realX1)}, ${Math.round(realY1)}) [norm: ${params.x1}, ${params.y1}]`,
      params
    );

    const feedbackId = Date.now();
    setActionFeedback({
      id: feedbackId,
      action: params.action,
      x: realX1,
      y: realY1,
      x2: realX2,
      y2: realY2,
      text: params.text,
    });

    setTimeout(() => {
      setActionFeedback((prev) => (prev && prev.id === feedbackId ? null : prev));
    }, 1200);

    // Dispatch OS-level system action via native Android accessibility service if enabled
    const DeviceControl = (window as unknown as {
      Capacitor?: { Plugins?: { DeviceControl?: { performAction: (args: any) => Promise<any> } } };
    }).Capacitor?.Plugins?.DeviceControl;
    const nativeActive = Boolean(DeviceControl && accessibilityEnabledRef.current);
    if (DeviceControl && nativeActive) {
      DeviceControl.performAction({
        action: params.action,
        x1: params.x1,
        y1: params.y1,
        x2: params.x2,
        y2: params.y2,
        scroll_speed: params.scroll_speed,
        scroll_duration_ms: params.scroll_duration_ms,
        text: params.text,
        press_enter: params.press_enter,
      }).catch((e: unknown) => {
        console.warn('[DeviceControl] Native gesture error:', e);
      });
    }

    const normalizedAction = (params.action || '').toLowerCase().replace(/^scroll_/, 'stroll_');

    if (nativeActive) {
      // The native accessibility service already performed the gesture on the
      // real screen. Do NOT also poke this app's own (hidden) DOM.
    } else if (normalizedAction === 'click') {
      const target = document.elementFromPoint(realX1, realY1);
      if (target) {
        const clickable =
          (target.closest('button, [role="button"], a, input, select, textarea, label') as HTMLElement) ||
          (target as HTMLElement);

        const eventInit = {
          bubbles: true,
          cancelable: true,
          clientX: realX1,
          clientY: realY1,
          button: 0,
        };

        clickable.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, isPrimary: true }));
        clickable.dispatchEvent(new MouseEvent('mousedown', eventInit));
        try {
          clickable.focus();
        } catch {}
        clickable.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, isPrimary: true }));
        clickable.dispatchEvent(new MouseEvent('mouseup', eventInit));
        clickable.dispatchEvent(new MouseEvent('click', eventInit));
        try {
          clickable.click();
        } catch {}
      }
    } else if (normalizedAction === 'type') {
      const target = document.elementFromPoint(realX1, realY1);
      let inputEl = target?.closest('input, textarea') as HTMLInputElement | HTMLTextAreaElement | null;
      if (
        !inputEl &&
        document.activeElement &&
        (document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLTextAreaElement)
      ) {
        inputEl = document.activeElement;
      }

      if (inputEl && typeof params.text === 'string') {
        try {
          inputEl.focus();
        } catch {}
        const prevVal = inputEl.value || '';
        const newVal = prevVal + params.text;

        const proto =
          inputEl instanceof HTMLInputElement
            ? window.HTMLInputElement.prototype
            : window.HTMLTextAreaElement.prototype;
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
        if (descriptor?.set) {
          descriptor.set.call(inputEl, newVal);
        } else {
          inputEl.value = newVal;
        }

        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));

        if (params.press_enter) {
          inputEl.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
          );
          inputEl.dispatchEvent(
            new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
          );
          inputEl.dispatchEvent(
            new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })
          );
          const form = inputEl.closest('form');
          if (form) {
            try {
              form.requestSubmit();
            } catch {
              form.dispatchEvent(new Event('submit', { bubbles: true }));
            }
          }
        }
      }
    } else if (
      normalizedAction === 'stroll_down' ||
      normalizedAction === 'stroll_up' ||
      normalizedAction === 'stroll_left' ||
      normalizedAction === 'stroll_right'
    ) {
      const speed = params.scroll_speed ?? 2;
      const baseDistance = Math.min(width, height) * 0.35;
      const multiplier = speed === 1 ? 0.5 : speed === 3 ? 1.5 : 1.0;
      const distance = baseDistance * multiplier;

      let deltaX = 0;
      let deltaY = 0;
      if (normalizedAction === 'stroll_down') deltaY = distance;
      else if (normalizedAction === 'stroll_up') deltaY = -distance;
      else if (normalizedAction === 'stroll_right') deltaX = distance;
      else if (normalizedAction === 'stroll_left') deltaX = -distance;

      const target = document.elementFromPoint(realX1, realY1);
      const container = findScrollableParent(target);

      try {
        target?.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaX,
            deltaY,
            clientX: realX1,
            clientY: realY1,
          })
        );
      } catch {}

      if (container === window) {
        window.scrollBy({ left: deltaX, top: deltaY, behavior: 'smooth' });
      } else {
        (container as Element).scrollBy({ left: deltaX, top: deltaY, behavior: 'smooth' });
      }
    }

    // Drag / gesture movement if x2 and y2 provided
    if (
      !nativeActive &&
      params.x2 !== undefined &&
      params.y2 !== undefined &&
      (params.x2 !== params.x1 || params.y2 !== params.y1)
    ) {
      const startTarget = document.elementFromPoint(realX1, realY1);
      if (startTarget) {
        try {
          startTarget.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: realX1, clientY: realY1, button: 0 })
          );
          startTarget.dispatchEvent(
            new PointerEvent('pointermove', { bubbles: true, cancelable: true, clientX: realX2, clientY: realY2, button: 0 })
          );
          startTarget.dispatchEvent(
            new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: realX2, clientY: realY2, button: 0 })
          );
        } catch {}
      }
    }

    setNetState((prev) => ({
      ...prev,
      uiActionCount: prev.uiActionCount + 1,
    }));
  }, []);

  // Execute system-level navigation action (home_click, previous, tab)
  const executeSystemAction = useCallback((params: { action: string }) => {
    const rawAction = (params.action || '').toLowerCase().trim();
    console.log(`[System Action] "${rawAction}"`, params);

    const feedbackId = Date.now();
    const width = window.innerWidth || 360;
    const height = window.innerHeight || 640;

    setActionFeedback({
      id: feedbackId,
      action: rawAction,
      x: width / 2,
      y: height - 40,
    });

    setTimeout(() => {
      setActionFeedback((prev) => (prev && prev.id === feedbackId ? null : prev));
    }, 1200);

    // Call native Android accessibility service
    const DeviceControl = (window as unknown as {
      Capacitor?: { Plugins?: { DeviceControl?: { performSystemAction: (args: any) => Promise<any> } } };
    }).Capacitor?.Plugins?.DeviceControl;

    const nativeActive = Boolean(DeviceControl && accessibilityEnabledRef.current);
    if (DeviceControl && nativeActive) {
      DeviceControl.performSystemAction({ action: rawAction }).catch((e: unknown) => {
        console.warn('[DeviceControl] System navigation error:', e);
      });
    }

    // Web fallback behavior
    if (rawAction === 'previous' || rawAction === 'back') {
      try {
        if (uiRef.current.isSettingsOpen) {
          setIsSettingsOpen(false);
        } else if (!nativeActive) {
          window.history.back();
        }
      } catch {}
    } else if (rawAction === 'home_click' || rawAction === 'home') {
      try {
        setIsSettingsOpen(false);
      } catch {}
    }

    setNetState((prev) => ({
      ...prev,
      uiActionCount: prev.uiActionCount + 1,
    }));
  }, []);

  // Execute direct intent action (YouTube, Zalo, Phone Call, Web Search, App)
  const executeIntentAction = useCallback((params: {
    target: string;
    query?: string;
    phone_number?: string;
    url?: string;
    package_name?: string;
  }) => {
    const rawTarget = (params.target || '').toLowerCase().trim();
    console.log(`[Intent Action] "${rawTarget}"`, params);

    const feedbackId = Date.now();
    const width = window.innerWidth || 360;
    const height = window.innerHeight || 640;

    setActionFeedback({
      id: feedbackId,
      action: `intent:${rawTarget}`,
      x: width / 2,
      y: height / 2,
      text: params.query || params.phone_number || params.url,
    });

    setTimeout(() => {
      setActionFeedback((prev) => (prev && prev.id === feedbackId ? null : prev));
    }, 1500);

    // Call native Android plugin
    const DeviceControl = (window as unknown as {
      Capacitor?: { Plugins?: { DeviceControl?: { launchIntent: (args: any) => Promise<any> } } };
    }).Capacitor?.Plugins?.DeviceControl;

    const nativeActive = Boolean(DeviceControl && accessibilityEnabledRef.current);
    if (DeviceControl && nativeActive) {
      DeviceControl.launchIntent(params).catch((e: unknown) => {
        console.warn('[DeviceControl] Launch intent error:', e);
      });
    }

    // Web fallback (only when the native service is not handling it)
    if (nativeActive) {
      // native already launched it
    } else if (rawTarget === 'web_search' && params.query) {
      window.open(`https://www.google.com/search?q=${encodeURIComponent(params.query)}`, '_blank');
    } else if (rawTarget === 'youtube' && params.query) {
      window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(params.query)}`, '_blank');
    } else if (rawTarget === 'phone_call' && params.phone_number) {
      window.location.href = `tel:${params.phone_number}`;
    } else if (rawTarget === 'browser' && params.url) {
      window.open(params.url, '_blank');
    }

    setNetState((prev) => ({
      ...prev,
      uiActionCount: prev.uiActionCount + 1,
    }));
  }, []);

  // Execute semantic UI element action (click by text/desc, type into element, read screen)
  const executeElementAction = useCallback((params: {
    action: string;
    target_text?: string;
    text_to_type?: string;
    press_enter?: boolean;
  }) => {
    const act = (params.action || 'click').toLowerCase().trim();
    console.log(`[Element Action] "${act}" target: "${params.target_text}"`, params);

    const feedbackId = Date.now();
    const width = window.innerWidth || 360;
    const height = window.innerHeight || 640;

    setActionFeedback({
      id: feedbackId,
      action: `element:${act}`,
      x: width / 2,
      y: height / 3,
      text: params.target_text || params.text_to_type,
    });

    setTimeout(() => {
      setActionFeedback((prev) => (prev && prev.id === feedbackId ? null : prev));
    }, 1500);

    // Call native Android plugin
    const DeviceControl = (window as unknown as {
      Capacitor?: { Plugins?: { DeviceControl?: { performElementAction: (args: any) => Promise<any> } } };
    }).Capacitor?.Plugins?.DeviceControl;

    const nativeActive = Boolean(DeviceControl && accessibilityEnabledRef.current);
    if (DeviceControl && nativeActive) {
      DeviceControl.performElementAction(params).then((res: any) => {
        console.log('[DeviceControl] Element action result:', res);
      }).catch((e: unknown) => {
        console.warn('[DeviceControl] Element action error:', e);
      });
    }

    // Web fallback for clicking elements by text
    if (!nativeActive && act === 'click' && params.target_text) {
      const q = params.target_text.toLowerCase();
      const allElements = Array.from(document.querySelectorAll('button, a, [role="button"], span, p, label'));
      const match = allElements.find((el) => el.textContent?.toLowerCase().includes(q)) as HTMLElement | undefined;
      if (match) {
        try { match.click(); } catch {}
      }
    }

    setNetState((prev) => ({
      ...prev,
      uiActionCount: prev.uiActionCount + 1,
    }));
  }, []);

  // Listen to /v2/screen/retrived and parse tool calls (perform_ui_action & perform_system_action)
  const startScreenReceiver = useCallback(
    (baseUrl: string, signal: AbortSignal) => {
      const listenEndpoint = `${baseUrl}/v2/screen/retrived`;

      const parseAction = (raw: any): { type: 'ui' | 'system' | 'intent' | 'element'; data: any } | null => {
        if (!raw || typeof raw !== 'object') return null;

        const name = raw.name || raw.function?.name;

        // 1. Explicit launch_intent
        if (name === 'launch_intent') {
          const args = raw.parameters || raw.function?.arguments || raw.args || raw;
          const parsed = typeof args === 'string' ? JSON.parse(args) : args;
          if (parsed?.target) {
            return { type: 'intent', data: parsed };
          }
        }

        // Direct target payload for intent: { target: 'youtube' | 'zalo' | 'phone_call' | ... }
        if (typeof raw.target === 'string' && (raw.target === 'youtube' || raw.target === 'zalo' || raw.target === 'phone_call' || raw.target === 'web_search' || raw.target === 'browser' || raw.target === 'app')) {
          return { type: 'intent', data: raw };
        }

        // 2. Explicit ui_element_action
        if (name === 'ui_element_action') {
          const args = raw.parameters || raw.function?.arguments || raw.args || raw;
          const parsed = typeof args === 'string' ? JSON.parse(args) : args;
          if (parsed?.action) {
            return { type: 'element', data: parsed };
          }
        }

        // Direct element action payload: { action: 'click' | 'type' | 'read_screen', target_text: ... }
        if (typeof raw.action === 'string' && (raw.target_text !== undefined || raw.action === 'read_screen') && raw.x1 === undefined) {
          return { type: 'element', data: raw };
        }

        // 3. Explicit perform_system_action
        if (name === 'perform_system_action') {
          const args = raw.parameters || raw.function?.arguments || raw.args || raw;
          const parsed = typeof args === 'string' ? JSON.parse(args) : args;
          if (parsed?.action) {
            return { type: 'system', data: { action: parsed.action } };
          }
        }

        // Direct system action payload: { action: 'home_click' | 'previous' | 'tab' }
        if (
          typeof raw.action === 'string' &&
          (raw.action === 'home_click' || raw.action === 'previous' || raw.action === 'tab') &&
          raw.x1 === undefined
        ) {
          return { type: 'system', data: { action: raw.action } };
        }

        // 4. Standard perform_ui_action payload: { action, x1, y1, ... }
        if (typeof raw.action === 'string' && typeof raw.x1 === 'number' && typeof raw.y1 === 'number') {
          return {
            type: 'ui',
            data: {
              action: raw.action,
              x1: raw.x1,
              y1: raw.y1,
              x2: typeof raw.x2 === 'number' ? raw.x2 : undefined,
              y2: typeof raw.y2 === 'number' ? raw.y2 : undefined,
              scroll_speed: typeof raw.scroll_speed === 'number' ? raw.scroll_speed : 2,
              scroll_duration_ms: typeof raw.scroll_duration_ms === 'number' ? raw.scroll_duration_ms : 400,
              text: typeof raw.text === 'string' ? raw.text : undefined,
              press_enter: Boolean(raw.press_enter),
            },
          };
        }

        if (raw.parameters && typeof raw.parameters === 'object') {
          const nested = parseAction(raw.parameters);
          if (nested) return nested;
        }
        if (raw.functionCall?.args && typeof raw.functionCall.args === 'object') {
          const nested = parseAction(raw.functionCall.args);
          if (nested) return nested;
        }
        if (Array.isArray(raw.tool_calls) && raw.tool_calls.length > 0) {
          const call = raw.tool_calls[0];
          if (call.function?.arguments) {
            try {
              const parsedArgs =
                typeof call.function.arguments === 'string'
                  ? JSON.parse(call.function.arguments)
                  : call.function.arguments;
              if (call.function.name === 'launch_intent' && parsedArgs?.target) {
                return { type: 'intent', data: parsedArgs };
              }
              if (call.function.name === 'ui_element_action' && parsedArgs?.action) {
                return { type: 'element', data: parsedArgs };
              }
              if (call.function.name === 'perform_system_action' && parsedArgs?.action) {
                return { type: 'system', data: { action: parsedArgs.action } };
              }
              const nested = parseAction(parsedArgs);
              if (nested) return nested;
            } catch {}
          }
        }
        if (raw.toolCall?.parameters) {
          const nested = parseAction(raw.toolCall.parameters);
          if (nested) return nested;
        }
        return null;
      };

      const dispatchParsedAction = (parsed: { type: 'ui' | 'system' | 'intent' | 'element'; data: any } | null) => {
        if (!parsed) return;
        if (parsed.type === 'intent') {
          executeIntentAction(parsed.data);
        } else if (parsed.type === 'element') {
          executeElementAction(parsed.data);
        } else if (parsed.type === 'system') {
          executeSystemAction(parsed.data);
        } else if (parsed.type === 'ui') {
          executeUiAction(parsed.data);
        }
      };

      const pollOrStream = async () => {
        try {
          console.log(`[Screen Receiver] Connecting to ${listenEndpoint}...`);
          const response = await fetch(listenEndpoint, {
            signal,
            headers: {
              'ngrok-skip-browser-warning': '1',
              Accept: 'application/json, text/event-stream, */*',
            },
          });

          if (!response.ok || !response.body) {
            console.warn(`[Screen Receiver] Stream response: ${response.status} ${response.statusText}`);
            if (!signal.aborted) {
              setTimeout(() => {
                if (!signal.aborted) pollOrStream();
              }, 2000);
            }
            return;
          }

          console.log('[Screen Receiver] Stream connected');
          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';

          while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;

              let jsonStr = trimmed;
              if (jsonStr.startsWith('data:')) {
                jsonStr = jsonStr.replace(/^data:\s*/, '').trim();
              }
              if (!jsonStr || jsonStr === '[DONE]') continue;

              try {
                const data = JSON.parse(jsonStr);
                if (Array.isArray(data)) {
                  for (const item of data) {
                    dispatchParsedAction(parseAction(item));
                  }
                } else {
                  dispatchParsedAction(parseAction(data));
                }
              } catch {
                // Ignore partial JSON
              }
            }
          }

          if (buffer.trim()) {
            try {
              let jsonStr = buffer.trim();
              if (jsonStr.startsWith('data:')) {
                jsonStr = jsonStr.replace(/^data:\s*/, '').trim();
              }
              const data = JSON.parse(jsonStr);
              dispatchParsedAction(parseAction(data));
            } catch {}
          }

          // Clean close (e.g. standard HTTP response completed): reconnect immediately (50ms) to avoid queue lag
          if (!signal.aborted) {
            setTimeout(() => {
              if (!signal.aborted) pollOrStream();
            }, 50);
          }
        } catch (err) {
          if (!signal.aborted) {
            console.warn('[Screen Receiver] Stream error, retrying in 1s:', err);
            setTimeout(() => {
              if (!signal.aborted) pollOrStream();
            }, 1000);
          }
        }
      };

      pollOrStream();
    },
    [executeUiAction, executeSystemAction, executeIntentAction, executeElementAction]
  );

  // =========================================================================
  // FIX (bug #2): Always-on receivers — decoupled from `inCall`.
  //
  // The command channel that delivers launch_intent / perform_* to the app was
  // previously opened only while a call was active. That's why the AI could
  // only control the device (open apps, click, type) during a call. We now
  // wire them up here, on mount, independent of call state.
  // =========================================================================

  // Always-on JS-side command receiver. On Android the native foreground
  // service owns the SSE stream, so we only start the JS receiver when the
  // native plugin is missing (web / PWA). This avoids double-dispatching.
  useEffect(() => {
    const hasNative = Boolean(
      (window as unknown as { Capacitor?: { Plugins?: { DeviceControl?: { startService?: unknown } } } })
        .Capacitor?.Plugins?.DeviceControl?.startService
    );
    if (hasNative) {
      console.log('[Always-On Receiver] Native DeviceControl present — native SSE owns the command stream.');
      return;
    }
    const abort = new AbortController();
    const baseUrl = getBaseUrlRef.current();
    console.log(`[Always-On Receiver] Starting JS SSE receiver at ${baseUrl}`);
    startScreenReceiver(baseUrl, abort.signal);
    return () => abort.abort();
  }, [startScreenReceiver, provider, hostInput, endpointInput]);

  // Always-on native foreground service. Starts whenever accessibility is
  // enabled and (re)starts if the base URL settings change.
  useEffect(() => {
    if (!accessibilityStatus.enabled) return;
    const DeviceControl = (window as unknown as {
      Capacitor?: { Plugins?: { DeviceControl?: { startService?: (args: { baseUrl: string }) => Promise<any> } } };
    }).Capacitor?.Plugins?.DeviceControl;
    if (!DeviceControl?.startService) return;

    const baseUrl = getBaseUrlRef.current();
    DeviceControl.startService({ baseUrl }).catch((e: unknown) => {
      console.warn('[NativeService] Always-on start failed:', e);
    });
  }, [accessibilityStatus.enabled, provider, hostInput, endpointInput]);

  // Render high-fidelity full-resolution viewport canvas snapshot
  const renderAppViewportToCanvas = useCallback(
    (canvas: HTMLCanvasElement): boolean => {
      const { cameraOn, isRecordingVoice, isSettingsOpen, actionFeedback } = uiRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return false;

      const dpr = Math.max(1, window.devicePixelRatio || 1);
      const w = Math.round((window.innerWidth || 360) * dpr);
      const h = Math.round((window.innerHeight || 640) * dpr);
      canvas.width = w;
      canvas.height = h;

      // 1. Warm pastel background #F0D1A8
      ctx.fillStyle = '#F0D1A8';
      ctx.fillRect(0, 0, w, h);

      // 2. Top video container: 83% of height, rounded bottom corners 40px
      const topH = Math.round(h * 0.83);
      const radius = Math.round(40 * dpr);

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(w, 0);
      ctx.lineTo(w, topH - radius);
      ctx.quadraticCurveTo(w, topH, w - radius, topH);
      ctx.lineTo(radius, topH);
      ctx.quadraticCurveTo(0, topH, 0, topH - radius);
      ctx.closePath();
      ctx.clip();

      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, w, topH);

      const video = videoRef.current;
      if (cameraOn && video && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const scale = Math.max(w / vw, topH / vh);
        const drawW = vw * scale;
        const drawH = vh * scale;
        const drawX = (w - drawW) / 2;
        const drawY = (topH - drawH) / 2;
        ctx.drawImage(video, drawX, drawY, drawW, drawH);
      } else {
        ctx.fillStyle = '#171717';
        ctx.fillRect(0, 0, w, topH);
        ctx.fillStyle = '#737373';
        ctx.font = `${Math.round(16 * dpr)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Camera Off', w / 2, topH / 2);
      }
      ctx.restore();

      // 3. Settings button in top right
      const btnSize = Math.round(44 * dpr);
      const btnMargin = Math.round(16 * dpr);
      const btnX = w - btnMargin - btnSize;
      const btnY = btnMargin;
      ctx.fillStyle = 'rgba(23, 23, 23, 0.85)';
      ctx.beginPath();
      ctx.roundRect(btnX, btnY, btnSize, btnSize, Math.round(12 * dpr));
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = Math.max(1, Math.round(1 * dpr));
      ctx.stroke();

      // 4. Bottom Controls
      const bottomH = h - topH;
      const centerY = topH + bottomH / 2 - Math.round(10 * dpr);
      const btnH = Math.round(56 * dpr);
      const maxBarW = Math.min(Math.round(w * 0.88), Math.round(384 * dpr));
      const startX = (w - maxBarW) / 2;
      const gap = Math.round(14 * dpr);
      const halfW = (maxBarW - gap) / 2;

      // Left button: Mic
      const micBg = isRecordingVoice ? '#E53935' : '#E57373';
      ctx.fillStyle = micBg;
      ctx.beginPath();
      ctx.roundRect(startX, centerY - btnH / 2, halfW, btnH, Math.round(20 * dpr));
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${Math.round(14 * dpr)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(isRecordingVoice ? 'REC...' : 'MIC', startX + halfW / 2, centerY);

      // Right button: End Call
      ctx.fillStyle = '#E57373';
      ctx.beginPath();
      ctx.roundRect(startX + halfW + gap, centerY - btnH / 2, halfW, btnH, Math.round(20 * dpr));
      ctx.fill();

      ctx.fillStyle = '#FFFFFF';
      ctx.font = `bold ${Math.round(14 * dpr)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('END', startX + halfW + gap + halfW / 2, centerY);

      // 5. Settings Modal if open
      if (isSettingsOpen) {
        ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.fillRect(0, 0, w, h);

        const modalW = Math.min(Math.round(w * 0.88), Math.round(400 * dpr));
        const modalH = Math.round(h * 0.7);
        const modalX = (w - modalW) / 2;
        const modalY = (h - modalH) / 2;

        ctx.fillStyle = '#171717';
        ctx.beginPath();
        ctx.roundRect(modalX, modalY, modalW, modalH, Math.round(24 * dpr));
        ctx.fill();
        ctx.strokeStyle = '#262626';
        ctx.lineWidth = Math.round(2 * dpr);
        ctx.stroke();

        ctx.fillStyle = '#FFFFFF';
        ctx.font = `bold ${Math.round(16 * dpr)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('Settings', modalX + modalW / 2, modalY + Math.round(34 * dpr));
      }

      // 6. Action Feedback indicator if active
      if (actionFeedback) {
        const fx = Math.round(actionFeedback.x * dpr);
        const fy = Math.round(actionFeedback.y * dpr);

        if (actionFeedback.action === 'click') {
          ctx.beginPath();
          ctx.arc(fx, fy, Math.round(18 * dpr), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(229, 115, 115, 0.4)';
          ctx.fill();
          ctx.strokeStyle = '#E57373';
          ctx.lineWidth = Math.round(3 * dpr);
          ctx.stroke();

          ctx.beginPath();
          ctx.arc(fx, fy, Math.round(6 * dpr), 0, Math.PI * 2);
          ctx.fillStyle = '#E57373';
          ctx.fill();
        } else if (actionFeedback.action === 'type') {
          ctx.fillStyle = '#10B981';
          ctx.beginPath();
          ctx.arc(fx, fy, Math.round(8 * dpr), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      return true;
    },
    []
  );

  // Toggle optional OS-level screen share via getDisplayMedia
  const handleToggleDeviceScreenShare = useCallback(async () => {
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => track.stop());
      screenStreamRef.current = null;
      if (screenVideoRef.current) screenVideoRef.current.srcObject = null;
      setIsSharingDeviceScreen(false);
    } else {
      if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
              width: { ideal: 1920 },
              height: { ideal: 1080 },
            },
          });
          screenStreamRef.current = stream;
          if (screenVideoRef.current) {
            screenVideoRef.current.srcObject = stream;
            screenVideoRef.current.play().catch(() => {});
          }
          setIsSharingDeviceScreen(true);
          stream.getVideoTracks().forEach((track) => {
            track.onended = () => {
              screenStreamRef.current = null;
              setIsSharingDeviceScreen(false);
            };
          });
        } catch (e) {
          console.warn('[Screen Share] Display media request cancelled or failed:', e);
        }
      } else {
        alert('DisplayMedia is not supported in this browser/WebView. Viewport capture is active.');
      }
    }
  }, []);

  // Manage call streaming lifecycle
  useEffect(() => {
    if (!inCall) {
      setNetState({
        status: 'idle',
        lastError: null,
        imgCount: 0,
        audioCount: 0,
        screenCount: 0,
        uiActionCount: 0,
      });
      // Stop and clean up all media and connections
      if (abortControllerRef.current) {
        stopVoiceRecording();
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (mediaStreamRef.current) {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
      }
      if (videoRef.current) {
        videoRef.current.srcObject = null;
      }
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((track) => track.stop());
        screenStreamRef.current = null;
      }
      if (screenVideoRef.current) {
        screenVideoRef.current.srcObject = null;
      }
      setIsSharingDeviceScreen(false);
      stopAudioPlayer();

      // NOTE: We deliberately DO NOT stop the native foreground service here.
      // It is now always-on (see the "Always-on native foreground service"
      // effect above), so the AI can control the device outside of calls.
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const baseUrl = getBaseUrlRef.current();

    // NOTE: Native service is started by the always-on effect above when
    // accessibility is enabled. We intentionally do NOT start/stop it here.

    setNetState({
      status: 'connecting',
      lastError: null,
      imgCount: 0,
      audioCount: 0,
      screenCount: 0,
      uiActionCount: 0,
    });
    console.log(`[Stream Started] Target server base URL: ${baseUrl}`);

    // Initialize AudioContext on user call gesture
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      audioContextRef.current = new AudioCtx();
      if (audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume();
      }
    }

    // Start receiver for audio output
    startAudioReceiver(baseUrl, abortController.signal);

    // Periodically poll native service telemetry to keep in-app stats updated
    const statsInterval = setInterval(async () => {
      if (abortController.signal.aborted) return;
      const DC = (window as unknown as {
        Capacitor?: { Plugins?: { DeviceControl?: { getServiceStatus?: () => Promise<any> } } };
      }).Capacitor?.Plugins?.DeviceControl;
      if (DC && typeof DC.getServiceStatus === 'function') {
        try {
          const st = await DC.getServiceStatus();
          if (st) {
            setNetState((prev) => ({
              ...prev,
              status: st.sseConnected || st.sent > 0 ? 'ok' : prev.status,
              screenCount: typeof st.sent === 'number' ? st.sent : prev.screenCount,
              uiActionCount: typeof st.actions === 'number' ? st.actions : prev.uiActionCount,
            }));
          }
        } catch {}
      }
    }, 2000);

    // Start video & audio media streams
    const initMedia = async () => {
      try {
        // Try back camera (facingMode: environment) first, fallback to any camera
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 } },
            audio: true,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true,
          });
        }

        if (abortController.signal.aborted) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        mediaStreamRef.current = stream;

        // Attach video stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }

        // Frame sender: a single self-paced loop. Each iteration fully awaits its
        // own draw -> encode -> upload under hard timeouts, so a hung network
        // call or a stuck toBlob can never wedge it. There is no shared "busy"
        // flag to desync, which is what used to make the loop stop permanently.
        const canvas = canvasRef.current || document.createElement('canvas');
        canvasRef.current = canvas;
        const ctx = canvas.getContext('2d');

        const FRAME_INTERVAL_MS = 1000 / 15;
        const UPLOAD_TIMEOUT_MS = 5000;
        const ENCODE_TIMEOUT_MS = 2000;

        const encodeFrame = (c: HTMLCanvasElement): Promise<Blob | null> =>
          new Promise((resolve) => {
            let settled = false;
            const done = (b: Blob | null) => {
              if (settled) return;
              settled = true;
              resolve(b);
            };
            const timer = setTimeout(() => done(null), ENCODE_TIMEOUT_MS);
            try {
              c.toBlob((b) => { clearTimeout(timer); done(b); }, 'image/webp', 0.6);
            } catch {
              clearTimeout(timer);
              done(null);
            }
          });

        const runFrameLoop = async () => {
          while (!abortController.signal.aborted) {
            const started = performance.now();
            try {
              const video = videoRef.current;
              if (uiRef.current.cameraOn && video && video.readyState >= 2 && video.videoWidth > 0 && ctx) {
                canvas.width = video.videoWidth;
                canvas.height = video.videoHeight;
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

                const blob = await encodeFrame(canvas);
                if (blob && !abortController.signal.aborted) {
                  const res = await postWithTimeout(
                    `${baseUrl}/v1/img/sent`,
                    {
                      method: 'POST',
                      headers: { 'Content-Type': 'image/webp' },
                      body: blob,
                      signal: abortController.signal,
                    },
                    UPLOAD_TIMEOUT_MS
                  );
                  if (res.ok) {
                    console.log(`[Image Sent] ${res.status} OK - ${blob.size} bytes`);
                    setNetState((prev) => ({
                      ...prev,
                      status: 'ok',
                      lastError: null,
                      imgCount: prev.imgCount + 1,
                    }));
                  } else {
                    const errorMsg = `Image HTTP ${res.status}`;
                    console.warn(`[Image Sent Error] ${errorMsg}`);
                    setNetState((prev) => ({ ...prev, status: 'error', lastError: errorMsg }));
                  }
                }
              }
            } catch (err: unknown) {
              if (!abortController.signal.aborted) {
                const msg = (err as Error)?.message || 'Image network error';
                console.error('[Image Sent Failed]', msg);
                setNetState((prev) => ({
                  ...prev,
                  status: 'error',
                  lastError: msg.includes('Failed to fetch') ? 'Connection Failed (Check IP/CORS)' : msg,
                }));
              }
            }
            const elapsed = performance.now() - started;
            await new Promise((r) => setTimeout(r, Math.max(0, FRAME_INTERVAL_MS - elapsed)));
          }
        };

        runFrameLoop();
      } catch (err) {
        console.error('Failed to access media devices:', err);
      }
    };

    initMedia();

    // FIX (bug #1 continued): every teardown step is now wrapped so a single
    // failure can't short-circuit the rest of the cleanup (which is what
    // produced the "background-only" screen on End Call).
    return () => {
      try { clearInterval(statsInterval); } catch {}
      try { abortController.abort(); } catch {}
      try { stopVoiceRecording(); } catch {}
      try { stopAudioPlayer(); } catch {}
      try {
        if (screenStreamRef.current) {
          screenStreamRef.current.getTracks().forEach((track) => track.stop());
          screenStreamRef.current = null;
        }
        if (screenVideoRef.current) {
          screenVideoRef.current.srcObject = null;
        }
        setIsSharingDeviceScreen(false);
      } catch {}
      // REMOVED: DeviceControl.stopService() — the service is always-on now.
    };
  }, [
    inCall,
    startAudioReceiver,
    stopAudioPlayer,
    stopVoiceRecording,
  ]);

  // Handle cameraOn toggle on live stream
  useEffect(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getVideoTracks().forEach((track) => {
        track.enabled = cameraOn;
      });
    }
  }, [cameraOn]);

  // Handle recorderOn toggle on live stream
  useEffect(() => {
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getAudioTracks().forEach((track) => {
        track.enabled = recorderOn;
      });
    }
  }, [recorderOn]);

  return (
    <div
      className="w-full h-screen min-h-screen flex flex-col overflow-hidden relative"
      style={{ backgroundColor: '#F0D1A8' }}
    >
      {/* Top section: Black box container with video stream, matching screen width with rounded bottom and shadow */}
      <div className="h-[83%] w-full bg-black rounded-b-[40px] sm:rounded-b-[48px] shadow-[0_16px_36px_rgba(0,0,0,0.22)] relative z-10 overflow-hidden flex items-center justify-center">
        {/* Hidden canvas for 15fps WebP image capture */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Hidden canvas & video elements for 1.5s phone screen capture */}
        <canvas ref={screenCanvasRef} className="hidden" />
        <video ref={screenVideoRef} autoPlay playsInline muted className="hidden" />

        {/* Live camera stream or Idle Screen */}
        {inCall && cameraOn ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover"
          />
        ) : inCall && !cameraOn ? (
          <div className="flex flex-col items-center justify-center text-neutral-600 gap-2">
            <svg xmlns="http://www.w3.org/2000/svg" height="40px" viewBox="0 -960 960 960" width="40px" fill="currentColor">
              <path d="m644-428-58-58q9-47-27-88t-87-32l-58-58q17-5 34-7.5t34-2.5q75 0 127.5 52.5T666-496q0 17-2.5 34T644-428Zm128 126-58-56q38-29 67-63.5t49-74.5q-50-101-143.5-160.5T480-716q-29 0-57 4t-55 12l-62-62q41-17 84-25.5t88-8.5q150 0 272.5 82.5T910-496q-24 53-60 98t-78 70ZM80-80l64-64q-63-47-106.5-108.5T-6-382q24-53 60-98t78-70q66-47 142.5-73.5T432-650l-80-80-56 56-56-56 56-56 56 56 320 320-56 56-56-56-80-80q-17 5-34 7.5t-34 2.5q-75 0-127.5-52.5T294-496q0-17 2.5-34T304-564l-80-80-56 56-56-56 56-56 56 56 320 320-56 56-56-56-80-80q-17 5-34 7.5t-34 2.5Z"/>
            </svg>
            <span className="text-xs text-neutral-500 font-medium">Camera Off</span>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center text-neutral-600 gap-3 select-none">
            <div className="w-16 h-16 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center shadow-inner">
              <svg xmlns="http://www.w3.org/2000/svg" height="28px" viewBox="0 -960 960 960" width="28px" fill="#737373">
                <path d="M480-480q33 0 56.5-23.5T560-560q0-33-23.5-56.5T480-640q-33 0-56.5 23.5T400-560q0 33 23.5 56.5T480-480Zm0 280q82 0 155-31.5t127.5-86Q815-372 847.5-445T880-600q0-83-32.5-156t-86-127Q708-936 635-968T480-1000q-83 0-156 32t-127 86q-54 54-85.5 127T80-600q0 82 32 155t86 127.5q54 54.5 127 86T480-200Z"/>
              </svg>
            </div>
            <span className="text-xs text-neutral-400 font-medium tracking-wide">Minimal Streamer Ready</span>
          </div>
        )}

        {/* Small square settings button on top right */}
        <button
          type="button"
          onClick={() => setIsSettingsOpen(true)}
          aria-label="Settings"
          className="absolute top-4 right-4 sm:top-5 sm:right-5 w-11 h-11 rounded-xl bg-neutral-900/85 hover:bg-neutral-800 active:scale-95 border border-white/10 transition-all shadow-sm flex items-center justify-center cursor-pointer outline-none z-20 backdrop-blur-xs"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            height="24px"
            viewBox="0 -960 960 960"
            width="24px"
            fill="#e3e3e3"
          >
            <path d="m370-80-16-128q-13-5-24.5-12T307-235l-119 50L78-375l103-78q-1-7-1-13.5v-27q0-6.5 1-13.5L78-585l110-190 119 50q11-8 23-15t24-12l16-128h220l16 128q13 5 24.5 12t22.5 15l119-50 110 190-103 78q1 7 1 13.5v27q0 6.5-2 13.5l103 78-110 190-118-50q-11 8-23 15t-24 12L590-80H370Zm70-80h79l14-106q31-8 57.5-23.5T639-327l99 41 39-68-86-65q5-14 7-29.5t2-31.5q0-16-2-31.5t-7-29.5l86-65-39-68-99 42q-22-23-48.5-38.5T533-694l-13-106h-79l-14 106q-31 8-57.5 23.5T321-633l-99-41-39 68 86 64q-5 15-7 30t-2 32q0 16 2 31t7 30l-86 65 39 68 99-42q22 23 48.5 38.5T427-266l13 106Zm42-180q58 0 99-41t41-99q0-58-41-99t-99-41q-59 0-99.5 41T342-480q0 58 40.5 99t99.5 41Zm-2-140Z" />
          </svg>
        </button>
      </div>

      {/* Middle Screen Panel */}
      {isSettingsOpen && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-in fade-in duration-150"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div
            className="w-[88%] max-w-sm sm:max-w-md bg-neutral-900 border border-neutral-800 rounded-3xl p-6 shadow-2xl flex flex-col gap-4 text-white relative max-h-[88vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Exit button */}
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setIsSettingsOpen(false)}
                aria-label="Exit"
                className="w-10 h-10 rounded-xl bg-neutral-800 hover:bg-neutral-700 active:scale-95 border border-white/10 flex items-center justify-center cursor-pointer transition-all outline-none"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  height="22px"
                  viewBox="0 -960 960 960"
                  width="22px"
                  fill="#e3e3e3"
                >
                  <path d="m256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z" />
                </svg>
              </button>
            </div>

            {/* Camera setting with smooth animated switch */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-neutral-800/60 border border-neutral-700/40">
              <span className="text-sm font-medium text-neutral-200">Camera</span>
              <button
                type="button"
                role="switch"
                aria-checked={cameraOn}
                onClick={() =>
                  setCameraOn((prev) => {
                    const next = !prev;
                    try { localStorage.setItem('streamer_camera', String(next)); } catch {}
                    return next;
                  })
                }
                className={`w-13 h-7 rounded-full p-0.5 transition-colors duration-300 ease-in-out cursor-pointer flex items-center outline-none ${
                  cameraOn ? 'bg-[#E57373]' : 'bg-neutral-800 border border-neutral-700'
                }`}
              >
                <div
                  className={`w-6 h-6 rounded-full bg-white shadow-md transform transition-transform duration-300 ease-in-out ${
                    cameraOn ? 'translate-x-6' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Recoder setting with smooth animated switch */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-neutral-800/60 border border-neutral-700/40">
              <span className="text-sm font-medium text-neutral-200">Recoder</span>
              <button
                type="button"
                role="switch"
                aria-checked={recorderOn}
                onClick={() =>
                  setRecorderOn((prev) => {
                    const next = !prev;
                    try { localStorage.setItem('streamer_recorder', String(next)); } catch {}
                    return next;
                  })
                }
                className={`w-13 h-7 rounded-full p-0.5 transition-colors duration-300 ease-in-out cursor-pointer flex items-center outline-none ${
                  recorderOn ? 'bg-[#E57373]' : 'bg-neutral-800 border border-neutral-700'
                }`}
              >
                <div
                  className={`w-6 h-6 rounded-full bg-white shadow-md transform transition-transform duration-300 ease-in-out ${
                    recorderOn ? 'translate-x-6' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>

            {/* Provider setting with smooth animated sliding indicator */}
            <div className="flex flex-col gap-2 p-3.5 rounded-2xl bg-neutral-800/60 border border-neutral-700/40">
              <span className="text-sm font-medium text-neutral-200">Provider</span>
              <div
                onClick={() => setProvider((prev) => (prev === 'localhost' ? 'server' : 'localhost'))}
                className="relative flex items-center bg-neutral-900/90 p-1 rounded-xl border border-neutral-700/50 cursor-pointer select-none"
              >
                {/* Sliding indicator */}
                <div
                  className={`absolute top-1 bottom-1 w-[calc(50%-4px)] rounded-lg bg-[#E57373] shadow-sm transition-all duration-300 ease-in-out ${
                    provider === 'localhost' ? 'left-1' : 'left-[calc(50%+2px)]'
                  }`}
                />
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setProvider('localhost');
                  }}
                  className={`relative z-10 w-1/2 py-2 text-xs font-medium text-center transition-colors duration-200 cursor-pointer outline-none ${
                    provider === 'localhost' ? 'text-white font-semibold' : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  Localhost
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setProvider('server');
                  }}
                  className={`relative z-10 w-1/2 py-2 text-xs font-medium text-center transition-colors duration-200 cursor-pointer outline-none ${
                    provider === 'server' ? 'text-white font-semibold' : 'text-neutral-400 hover:text-white'
                  }`}
                >
                  Server
                </button>
              </div>

              {provider === 'localhost' ? (
                <>
                  <input
                    type="text"
                    key="localhost-input"
                    value={hostInput}
                    onChange={(e) => setHostInput(e.target.value)}
                    placeholder="localhost:8000"
                    className="w-full mt-1 px-3.5 py-2.5 rounded-xl bg-neutral-900 border border-neutral-700 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-[#E57373] transition-all"
                  />
                  <p className="text-[11px] text-neutral-400 leading-normal mt-1">
                    <span className="text-[#E57373] font-semibold">Tip for Android:</span> On a phone, &apos;localhost&apos; is the phone itself. Use your PC&apos;s Wi-Fi IP (e.g. <code className="text-neutral-200">http://192.168.1.X:8000</code>) or USB <code className="text-neutral-200">adb reverse tcp:8000 tcp:8000</code>.
                  </p>
                </>
              ) : (
                <input
                  type="text"
                  key="server-input"
                  value={endpointInput}
                  onChange={(e) => setEndpointInput(e.target.value)}
                  placeholder="https://api.server.com/endpoint"
                  className="w-full mt-1 px-3.5 py-2.5 rounded-xl bg-neutral-900 border border-neutral-700 text-sm text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-[#E57373] transition-all"
                />
              )}
            </div>

            {/* System Accessibility Control Option (for whole-device control across all apps) */}
            <div className="flex flex-col gap-2 p-3.5 rounded-2xl bg-neutral-800/60 border border-neutral-700/40">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-neutral-200">System Control (All Apps)</span>
                <span
                  className={`text-[11px] font-semibold px-2 py-0.5 rounded-md ${
                    accessibilityStatus.enabled
                      ? 'bg-emerald-950 text-emerald-300 border border-emerald-700/40'
                      : 'bg-neutral-850 text-neutral-400 border border-neutral-700'
                  }`}
                >
                  {accessibilityStatus.enabled ? 'Always-On' : 'In-App Only'}
                </span>
              </div>
              <p className="text-[11px] text-neutral-400 leading-normal">
                {accessibilityStatus.enabled
                  ? 'AI assistant is running in the background and can click, scroll, and type across all apps — even when no call is active.'
                  : 'Enable Android Accessibility to allow the AI assistant to click, scroll, and type outside this app across the entire device, at any time.'}
              </p>
              {!accessibilityStatus.enabled ? (
                <button
                  type="button"
                  onClick={handleOpenAccessibilitySettings}
                  className="mt-1 w-full py-2 px-3 rounded-xl bg-neutral-700 hover:bg-neutral-600 text-xs font-medium text-white transition-all flex items-center justify-center gap-1.5 cursor-pointer outline-none"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" height="16px" viewBox="0 -960 960 960" width="16px" fill="currentColor">
                    <path d="M480-80q-83 0-156-31.5T197-197q-54-54-85.5-127T80-480q0-83 31.5-156T197-763q54-54 127-85.5T480-880q83 0 156 31.5T763-763q54 54 85.5 127T880-480q0 83-31.5 156T763-197q-54 54-127 85.5T480-80Zm0-80q134 0 227-93t93-227q0-134-93-227t-227-93q-134 0-227 93t-93 227q0 134 93 227t227 93Zm0-320Z"/>
                  </svg>
                  <span>Enable System Control</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleStopSystemControl}
                  className="mt-1 w-full py-2 px-3 rounded-xl bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-xs font-medium text-neutral-300 hover:text-white transition-all flex items-center justify-center gap-1.5 cursor-pointer outline-none"
                >
                  <span>Disable Background Assistant</span>
                </button>
              )}
            </div>

            {/* Device Screen Share option */}
            <div className="flex items-center justify-between p-3.5 rounded-2xl bg-neutral-800/60 border border-neutral-700/40">
              <div className="flex flex-col">
                <span className="text-sm font-medium text-neutral-200">Screen Capture</span>
                <span className="text-[11px] text-neutral-400">
                  {isSharingDeviceScreen ? 'OS DisplayMedia active' : 'Auto full-res viewport capture active'}
                </span>
              </div>
              <button
                type="button"
                onClick={handleToggleDeviceScreenShare}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium cursor-pointer transition-all outline-none ${
                  isSharingDeviceScreen
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-200'
                }`}
              >
                {isSharingDeviceScreen ? 'Stop Share' : 'Share OS Screen'}
              </button>
            </div>

            {/* Save & Check Connection Button & Status */}
            <div className="flex flex-col gap-2.5 pt-1">
              <button
                type="button"
                onClick={handleSaveAndCheckConnection}
                disabled={connectionCheck.status === 'checking'}
                className="w-full py-3 px-4 rounded-2xl bg-[#E57373] hover:bg-[#e06666] active:scale-[0.98] disabled:opacity-60 text-white font-medium text-sm transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer outline-none"
              >
                {connectionCheck.status === 'checking' ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                    </svg>
                    <span>Checking Connection...</span>
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" height="18px" viewBox="0 -960 960 960" width="18px" fill="currentColor">
                      <path d="M840-680v480q0 33-23.5 56.5T760-120H200q-33 0-56.5-23.5T120-200v-560q0-33 23.5-56.5T200-840h480l160 160Zm-80 34L646-760H200v560h560v-446ZM480-240q50 0 85-35t35-85q0-50-35-85t-85-35q-50 0-85 35t-35 85q0 50 35 85t85 35ZM240-560h360v-160H240v160Zm-40-86v446-560 114Z" />
                    </svg>
                    <span>Save &amp; Check Connection</span>
                  </>
                )}
              </button>

              {/* Result Panel */}
              {connectionCheck.status !== 'idle' && (
                <div
                  className={`p-3.5 rounded-2xl border text-xs leading-relaxed flex flex-col gap-1.5 transition-all ${
                    connectionCheck.status === 'success'
                      ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-200'
                      : connectionCheck.status === 'error'
                      ? 'bg-rose-950/40 border-rose-500/40 text-rose-200'
                      : 'bg-neutral-800/60 border-neutral-700/50 text-neutral-300'
                  }`}
                >
                  <div className="flex items-center gap-2 font-semibold">
                    {connectionCheck.status === 'success' && (
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    )}
                    {connectionCheck.status === 'error' && (
                      <span className="w-2 h-2 rounded-full bg-rose-500" />
                    )}
                    {connectionCheck.status === 'checking' && (
                      <span className="w-2 h-2 rounded-full bg-amber-400 animate-ping" />
                    )}
                    <span>
                      {connectionCheck.status === 'success'
                        ? `Server Connected ${connectionCheck.pingMs ? `(${connectionCheck.pingMs}ms)` : ''}`
                        : connectionCheck.status === 'error'
                        ? 'Connection Check Failed'
                        : 'Testing Connection...'}
                    </span>
                  </div>
                  <p className="text-[11px] opacity-90">{connectionCheck.message}</p>
                </div>
              )}

              {/* Active Streaming Telemetry (when in a call) */}
              {inCall && (
                <div className="p-3 rounded-2xl bg-neutral-800/40 border border-neutral-700/40 text-xs text-neutral-300 flex items-center justify-between">
                  <span className="text-[11px] text-neutral-400">Live Call Stats:</span>
                  <span className="font-mono text-[11px] text-neutral-200">
                    {netState.imgCount} cam • {netState.screenCount} screens • {netState.audioCount} audio • {netState.uiActionCount} actions
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Bottom section: Controls area */}
      <div className="flex-1 w-full flex items-center justify-center px-4">
        {!inCall ? (
          <button
            type="button"
            onClick={() => setInCall(true)}
            aria-label="Start call"
            className="w-[88%] max-w-sm h-14 sm:h-16 rounded-2xl sm:rounded-3xl bg-[#E57373] hover:bg-[#e06666] active:scale-[0.98] transition-all shadow-[0_10px_25px_rgba(229,115,115,0.42),0_4px_10px_rgba(0,0,0,0.08)] active:shadow-[0_4px_12px_rgba(229,115,115,0.3)] flex items-center justify-center cursor-pointer border-none outline-none -translate-y-5"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              height="28px"
              viewBox="0 -960 960 960"
              width="28px"
              fill="white"
            >
              <path d="M798-120q-125 0-247-54.5T329-329Q229-429 174.5-551T120-798q0-18 12-30t30-12h162q14 0 25 9.5t13 22.5l26 140q2 16-1 27t-11 19l-97 98q20 37 47.5 71.5T387-386q31 31 65 57.5t72 48.5l94-94q9-9 23.5-13.5T670-390l138 28q14 4 23 14.5t9 23.5v162q0 18-12 30t-30 12ZM241-600l66-66-17-94h-89q5 41 14 81t26 79Zm358 358q39 17 79.5 27t81.5 13v-88l-94-19-67 67ZM241-600Zm358 358Z" />
            </svg>
          </button>
        ) : (
          <div className="w-[88%] max-w-sm flex items-center gap-3.5 -translate-y-5">
            {/* Left half: Record / Mic Button (Hold to Record, Release to Send) */}
            <button
              type="button"
              onPointerDown={(e) => {
                e.preventDefault();
                try {
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                } catch {}
                startVoiceRecording();
              }}
              onPointerUp={(e) => {
                e.preventDefault();
                stopVoiceRecording();
              }}
              onPointerCancel={(e) => {
                // Do NOT immediately stop on cancel from WebView gesture recognition unless finger actually lifted
                e.preventDefault();
              }}
              onTouchStart={(e) => {
                e.stopPropagation();
              }}
              onTouchEnd={(e) => {
                e.preventDefault();
                stopVoiceRecording();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                return false;
              }}
              aria-label="Hold to record voice"
              style={{ WebkitTouchCallout: 'none', userSelect: 'none', touchAction: 'none' }}
              className={`flex-1 h-14 sm:h-16 rounded-2xl sm:rounded-3xl transition-all duration-200 flex items-center justify-center gap-2 cursor-pointer border-none outline-none select-none touch-none ${
                isRecordingVoice
                  ? 'bg-[#E53935] scale-[1.03] shadow-[0_12px_28px_rgba(229,57,53,0.55)] ring-4 ring-red-400/30'
                  : 'bg-[#E57373] hover:bg-[#e06666] active:scale-[0.98] shadow-[0_10px_25px_rgba(229,115,115,0.42),0_4px_10px_rgba(0,0,0,0.08)]'
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="26px"
                viewBox="0 -960 960 960"
                width="26px"
                fill="white"
                className={isRecordingVoice ? 'animate-pulse' : ''}
              >
                <path d="M480-400q-50 0-85-35t-35-85v-240q0-50 35-85t85-35q50 0 85 35t35 85v240q0 50-35 85t-85 35Zm0-240Zm-40 520v-123q-104-14-172-93t-68-184h80q0 83 58.5 141.5T480-320q83 0 141.5-58.5T680-520h80q0 105-68 184t-172 93v123h-80Zm40-360q17 0 28.5-11.5T520-520v-240q0-17-11.5-28.5T480-800q-17 0-28.5 11.5T440-760v240q0 17 11.5 28.5T480-480Z" />
              </svg>
              {isRecordingVoice && (
                <span className="text-white text-xs font-semibold tracking-wider animate-pulse uppercase">
                  Rec...
                </span>
              )}
            </button>

            {/* Right half: End Call Button */}
            <button
              type="button"
              onClick={() => setInCall(false)}
              aria-label="End call"
              className="flex-1 h-14 sm:h-16 rounded-2xl sm:rounded-3xl bg-[#E57373] hover:bg-[#e06666] active:scale-[0.98] transition-all shadow-[0_10px_25px_rgba(229,115,115,0.42),0_4px_10px_rgba(0,0,0,0.08)] active:shadow-[0_4px_12px_rgba(229,115,115,0.3)] flex items-center justify-center cursor-pointer border-none outline-none"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                height="28px"
                viewBox="0 -960 960 960"
                width="28px"
                fill="white"
              >
                <path d="m136-304-92-90q-12-12-12-28t12-28q88-95 203-142.5T480-640q118 0 232.5 47.5T916-450q12 12 12 28t-12 28l-92 90q-11 11-25.5 12t-26.5-8l-116-88q-8-6-12-14t-4-18v-114q-38-12-78-19t-82-7q-42 0-82 7t-78 19v114q0 10-4 18t-12 14l-116 88q-12 9-26.5 8T136-304Zm104-198q-29 15-56 34.5T128-424l40 40 72-56v-62Zm480 2v60l72 56 40-38q-29-26-56-45t-56-33Zm-480-2Zm480 2Z" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Visual Feedback Overlay for AI UI actions (Click / Type / Stroll) */}
      {actionFeedback && (
        <div className="fixed inset-0 pointer-events-none z-50 overflow-hidden">
          {actionFeedback.action === 'click' && (
            <div
              className="absolute -translate-x-1/2 -translate-y-1/2 flex items-center justify-center transition-all duration-300"
              style={{ left: actionFeedback.x, top: actionFeedback.y }}
            >
              <div className="w-12 h-12 rounded-full border-2 border-[#E57373] bg-[#E57373]/25 animate-ping" />
              <div className="w-4 h-4 rounded-full bg-[#E57373] absolute shadow-lg ring-2 ring-white" />
            </div>
          )}

          {actionFeedback.action === 'type' && (
            <div
              className="absolute -translate-x-1/2 -translate-y-full mb-3 flex flex-col items-center transition-all duration-200"
              style={{ left: actionFeedback.x, top: actionFeedback.y }}
            >
              <div className="px-3 py-1.5 rounded-full bg-neutral-900/95 border border-neutral-700 text-xs text-neutral-100 shadow-xl backdrop-blur-xs flex items-center gap-1.5 animate-bounce">
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-mono font-medium max-w-[200px] truncate">
                  {actionFeedback.text ? `Type: "${actionFeedback.text}"` : 'Typing...'}
                </span>
              </div>
              <div className="w-3.5 h-3.5 rounded-full bg-emerald-400 ring-2 ring-white shadow-md mt-1" />
            </div>
          )}

          {actionFeedback.action.startsWith('stroll_') && (
            <div
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center transition-all duration-300"
              style={{ left: actionFeedback.x, top: actionFeedback.y }}
            >
              <div className="px-3.5 py-1.5 rounded-full bg-neutral-900/95 border border-neutral-700 text-xs text-neutral-100 shadow-xl backdrop-blur-xs flex items-center gap-2 animate-pulse">
                <span className="w-2 h-2 rounded-full bg-sky-400" />
                <span className="capitalize font-medium">
                  {actionFeedback.action.replace('_', ' ')}
                </span>
              </div>
            </div>
          )}

          {(actionFeedback.action === 'home_click' ||
            actionFeedback.action === 'home' ||
            actionFeedback.action === 'previous' ||
            actionFeedback.action === 'back' ||
            actionFeedback.action === 'tab' ||
            actionFeedback.action === 'recents') && (
            <div
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center transition-all duration-300"
              style={{ left: actionFeedback.x, top: actionFeedback.y }}
            >
              <div className="px-4 py-2 rounded-full bg-neutral-900/95 border border-amber-500/50 text-xs text-amber-200 shadow-xl backdrop-blur-xs flex items-center gap-2 animate-bounce">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 animate-ping" />
                <span className="font-semibold tracking-wide uppercase">
                  OS: {actionFeedback.action === 'home_click' || actionFeedback.action === 'home'
                    ? 'Home'
                    : actionFeedback.action === 'previous' || actionFeedback.action === 'back'
                    ? 'Back'
                    : 'Recents (Tab)'}
                </span>
              </div>
            </div>
          )}

          {actionFeedback.action.startsWith('intent:') && (
            <div
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center transition-all duration-300"
              style={{ left: actionFeedback.x, top: actionFeedback.y }}
            >
              <div className="px-4 py-2 rounded-full bg-neutral-900/95 border border-violet-500/50 text-xs text-violet-200 shadow-xl backdrop-blur-xs flex items-center gap-2 animate-bounce">
                <span className="w-2.5 h-2.5 rounded-full bg-violet-400 animate-ping" />
                <span className="font-semibold tracking-wide capitalize">
                  Intent: {actionFeedback.action.replace('intent:', '').replace('_', ' ')}
                  {actionFeedback.text ? ` ("${actionFeedback.text}")` : ''}
                </span>
              </div>
            </div>
          )}

          {actionFeedback.action.startsWith('element:') && (
            <div
              className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center justify-center transition-all duration-300"
              style={{ left: actionFeedback.x, top: actionFeedback.y }}
            >
              <div className="px-4 py-2 rounded-full bg-neutral-900/95 border border-emerald-500/50 text-xs text-emerald-200 shadow-xl backdrop-blur-xs flex items-center gap-2 animate-bounce">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="font-semibold tracking-wide capitalize">
                  UI: {actionFeedback.action.replace('element:', '')} {actionFeedback.text ? `("${actionFeedback.text}")` : ''}
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
