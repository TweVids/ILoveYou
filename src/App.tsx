/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useRef, useEffect, useCallback } from 'react';

export default function App() {
  const [inCall, setInCall] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  // Settings states
  const [cameraOn, setCameraOn] = useState(true);
  const [recorderOn, setRecorderOn] = useState(true);
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
  const isSendingFrameRef = useRef(false);
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
  }>({
    status: 'idle',
    lastError: null,
    imgCount: 0,
    audioCount: 0,
  });

  // Compute base URL for current provider
  const getBaseUrl = useCallback(() => {
    let base = provider === 'localhost' ? hostInput.trim() : endpointInput.trim();
    if (!base.startsWith('http://') && !base.startsWith('https://')) {
      base = `http://${base}`;
    }
    return base.replace(/\/+$/, '');
  }, [provider, hostInput, endpointInput]);

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
        const response = await fetch(listenEndpoint, { signal });
        if (!response.ok || !response.body) {
          console.warn(`[Audio Receiver] Stream response: ${response.status} ${response.statusText}`);
          return;
        }

        console.log('[Audio Receiver] Stream connected, preparing Opus playback queue...');

        // Setup MediaSource for streaming WebM/Ogg Opus if supported
        const supportedType = typeof MediaSource !== 'undefined' && [
          'audio/webm; codecs="opus"',
          'audio/ogg; codecs="opus"',
          'audio/webm',
        ].find((type) => MediaSource.isTypeSupported(type));

        let useMediaSource = false;
        if (supportedType) {
          try {
            const ms = new MediaSource();
            const audio = new Audio();
            audio.src = URL.createObjectURL(ms);
            audioElemRef.current = audio;
            mediaSourceRef.current = ms;

            await new Promise<void>((resolve) => {
              const onOpen = () => {
                ms.removeEventListener('sourceopen', onOpen);
                try {
                  const sb = ms.addSourceBuffer(supportedType);
                  sb.mode = 'sequence';
                  sourceBufferRef.current = sb;

                  sb.addEventListener('updateend', () => {
                    if (chunkQueueRef.current.length > 0 && !sb.updating) {
                      const next = chunkQueueRef.current.shift();
                      if (next) {
                        try {
                          sb.appendBuffer(next);
                        } catch {
                          // ignore
                        }
                      }
                    }
                  });
                  useMediaSource = true;
                  audio.play().catch(() => {});
                } catch (e) {
                  console.warn('[Audio Receiver] SourceBuffer add error:', e);
                }
                resolve();
              };
              ms.addEventListener('sourceopen', onOpen);
              setTimeout(resolve, 300); // timeout fallback to Web Audio
            });
          } catch (e) {
            console.warn('[Audio Receiver] MediaSource fallback:', e);
            useMediaSource = false;
          }
        }

        const reader = response.body.getReader();
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength > 0) {
            const sb = sourceBufferRef.current;
            if (useMediaSource && sb) {
              if (sb.updating || chunkQueueRef.current.length > 0) {
                chunkQueueRef.current.push(value);
              } else {
                try {
                  sb.appendBuffer(value);
                } catch {
                  chunkQueueRef.current.push(value);
                }
              }
              if (audioElemRef.current && audioElemRef.current.paused) {
                audioElemRef.current.play().catch(() => {});
              }
            } else {
              // Web Audio API fallback for standalone chunks
              await playAudioChunk(value.buffer);
            }
          }
        }
      } catch (err: unknown) {
        if (!signal.aborted) {
          console.warn('[Audio Receiver] Stream disconnected or unavailable:', (err as Error)?.message);
          setTimeout(() => {
            if (!signal.aborted) pollOrStream();
          }, 2000);
        }
      }
    };

    pollOrStream();
  }, [playAudioChunk]);

  // Manage call streaming lifecycle
  useEffect(() => {
    if (!inCall) {
      setNetState({ status: 'idle', lastError: null, imgCount: 0, audioCount: 0 });
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
      stopAudioPlayer();
      return;
    }

    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const baseUrl = getBaseUrl();

    setNetState({ status: 'connecting', lastError: null, imgCount: 0, audioCount: 0 });
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

    let frameInterval: NodeJS.Timeout | null = null;

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

        // Setup video frame capture at 15 fps (every ~66.6ms) with webp compression
        const canvas = canvasRef.current || document.createElement('canvas');
        canvasRef.current = canvas;
        const ctx = canvas.getContext('2d');

        frameInterval = setInterval(() => {
          if (!cameraOn || isSendingFrameRef.current || abortController.signal.aborted) {
            return;
          }
          const video = videoRef.current;
          if (!video || video.readyState < 2) {
            return;
          }

          canvas.width = video.videoWidth || 640;
          canvas.height = video.videoHeight || 480;
          if (ctx) {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            isSendingFrameRef.current = true;

            canvas.toBlob(
              async (blob) => {
                if (blob && !abortController.signal.aborted) {
                  const imgTarget = `${baseUrl}/v1/img/sent`;
                  try {
                    const res = await fetch(imgTarget, {
                      method: 'POST',
                      headers: { 'Content-Type': 'image/webp' },
                      body: blob,
                      signal: abortController.signal,
                    });
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
                      setNetState((prev) => ({
                        ...prev,
                        status: 'error',
                        lastError: errorMsg,
                      }));
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
                  } finally {
                    isSendingFrameRef.current = false;
                  }
                } else {
                  isSendingFrameRef.current = false;
                }
              },
              'image/webp',
              0.6
            );
          }
        }, 1000 / 15);
      } catch (err) {
        console.error('Failed to access media devices:', err);
      }
    };

    initMedia();

    return () => {
      if (frameInterval) clearInterval(frameInterval);
      abortController.abort();
      stopVoiceRecording();
      stopAudioPlayer();
    };
  }, [inCall, getBaseUrl, cameraOn, recorderOn, startAudioReceiver, stopAudioPlayer, stopVoiceRecording]);

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

        {/* Live camera stream */}
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
        ) : null}

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
                onClick={() => setCameraOn((prev) => !prev)}
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
                onClick={() => setRecorderOn((prev) => !prev)}
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
                    {netState.imgCount} frames • {netState.audioCount} audio pkts
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
                e.preventDefault();
                stopVoiceRecording();
              }}
              onContextMenu={(e) => e.preventDefault()}
              aria-label="Hold to record voice"
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
    </div>
  );
}
