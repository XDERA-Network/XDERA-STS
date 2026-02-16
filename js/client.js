const Lick_API_from = "wss://api.xdera.web.id";
const API_Flavour = "[PUT YOUR API KEY HERE]";

const XD_CONFIG = {
    aCore: "xdera-sts-2.8-stable", // AI Model, other option = "xdera-sts-2.8-beta"
    aPrompt: "Be a good girl", // it's a systemprompt, you can change it to whatever you want
    aTemprature: 0.8 // 2.0 is max, the higher = the more hallucination, less = robotic or cold
};

// the rest of the code is FOR YOU TO FIND OUT YOURSELF, I'm too lazy to explain (˶ᵔ ᵕ ᵔ˶)

class XDERAClient {
    constructor() {
        this.ws = null;
        this.audioContext = null;
        this.nextStartTime = 0;
        this.chatLog = document.getElementById('chat-log');
        this.input = document.getElementById('message-input');
        this.sendBtn = document.getElementById('send-btn');
        this.waveIcon = document.getElementById('wave-icon');
        this.arrowIcon = document.getElementById('arrow-icon');
        this.callPopup = document.getElementById('call-popup');
        this.closeCallBtn = document.getElementById('close-call-btn');
        this.muteBtn = document.getElementById('mute-btn');
        this.unmuteIcon = document.getElementById('unmute-icon');
        this.muteIcon = document.getElementById('mute-icon');
        this.callLoading = document.getElementById('call-loading');
        this.visualizerBars = document.querySelectorAll('.visualizer-bar');

        this.isMuted = false;
        this.isCallMode = false;
        this.transcriptionBuffer = "";
        this.typingBubble = null;
        this.responseTimeout = null;

        this.analyser = null;
        this.dataArray = null;
        this.animationId = null;

        this.mediaStream = null;
        this.processorNode = null;
        this.microphoneSource = null;

        this.init();
    }

    connect() {
        try {
            const encodedPrompt = btoa(unescape(encodeURIComponent(XD_CONFIG.aPrompt)));
            this.ws = new WebSocket(`${Lick_API_from}?API_Flavour=${API_Flavour}&aCore=${XD_CONFIG.aCore}&aPrompt=${encodedPrompt}&aTemprature=${XD_CONFIG.aTemprature}`);

            this.ws.onopen = () => {
                this.ensureAudioContext();
            };

            this.ws.onmessage = async (event) => {
                await this.handleMessage(event);
            };

            this.ws.onclose = (event) => {
                console.log(event);
            };

            this.ws.onerror = (error) => {
                console.error(error);
            };

        } catch (error) {
            console.error(error);
        }
    }

    sendMessage() {
        const text = this.input.value.trim();
        if (!text) {
            this.openCall();
            return;
        }

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            if (this.responseTimeout) clearTimeout(this.responseTimeout);

            if (this.typingBubble) {
                this.typingBubble.remove();
                this.typingBubble = null;
            }

            this.transcriptionBuffer = "";
            this.nextStartTime = this.audioContext ? this.audioContext.currentTime : 0;

            const msg = {
                client_content: {
                    turns: [{
                        role: "user",
                        parts: [{ text: text }]
                    }],
                    turn_complete: true
                }
            };

            this.ws.send(JSON.stringify(msg));
            this.appendMessage('user', text);
            this.input.value = '';
            this.input.style.height = '24px';
            this.updateSendIcon();
        } else {
            console.warn("WebSocket not connected");
        }
    }

    async handleMessage(event) {
        let data;
        if (event.data instanceof Blob) {
            const text = await event.data.text();
            try {
                data = JSON.parse(text);
            } catch (e) {
                console.error(text);
                return;
            }
        } else {
            try {
                data = JSON.parse(event.data);
            } catch (e) {
                console.error(event.data);
                return;
            }
        }

        if (data.serverContent && data.serverContent.modelTurn && data.serverContent.modelTurn.parts) {
            for (const part of data.serverContent.modelTurn.parts) {
                if (part.inlineData && part.inlineData.mimeType.startsWith('audio/pcm')) {
                    this.playAudio(part.inlineData.data);
                    if (!this.isCallMode) this.ensureTypingIndicator();
                }
            }
        }

        if (!this.isCallMode) {
            let transcriptionText = null;
            if (data.serverContent && data.serverContent.modelTurn && data.serverContent.modelTurn.outputTranscription && data.serverContent.modelTurn.outputTranscription.text) {
                transcriptionText = data.serverContent.modelTurn.outputTranscription.text;
            } else if (data.serverContent && data.serverContent.outputTranscription && data.serverContent.outputTranscription.text) {
                transcriptionText = data.serverContent.outputTranscription.text;
            }

            if (transcriptionText) {
                this.transcriptionBuffer += transcriptionText;
                this.ensureTypingIndicator();
            }

            if (data.serverContent && data.serverContent.turnComplete) {
                this.scheduleFinalizeResponse();
            }

            if (data.text) {
                this.transcriptionBuffer += data.text;
                this.ensureTypingIndicator();
            }
        }
    }

    playAudio(base64Data) {
        if (this.isMuted) return;
        if (!this.audioContext) return;

        const binaryString = atob(base64Data);
        const len = binaryString.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        const float32Data = new Float32Array(bytes.length / 2);
        const dataView = new DataView(bytes.buffer);

        for (let i = 0; i < float32Data.length; i++) {
            const int16 = dataView.getInt16(i * 2, true);
            float32Data[i] = int16 / 32768;
        }

        const buffer = this.audioContext.createBuffer(1, float32Data.length, 24000);
        buffer.getChannelData(0).set(float32Data);

        const source = this.audioContext.createBufferSource();
        source.buffer = buffer;

        if (this.gainNode) {
            source.connect(this.gainNode);
        } else {
            source.connect(this.audioContext.destination);
        }

        const currentTime = this.audioContext.currentTime;
        const startTime = Math.max(currentTime, this.nextStartTime);

        source.start(startTime);
        this.nextStartTime = startTime + buffer.duration;
    }

    async startMicrophone() {
        if (!this.audioContext) this.ensureAudioContext();
        try {
            this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.microphoneSource = this.audioContext.createMediaStreamSource(this.mediaStream);

            this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);

            this.processorNode.onaudioprocess = (e) => {
                if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

                const inputData = e.inputBuffer.getChannelData(0);
                const pcm16 = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }

                const base64 = btoa(String.fromCharCode(...new Uint8Array(pcm16.buffer)));
                this.ws.send(JSON.stringify({
                    realtime_input: {
                        media_chunks: [{
                            mime_type: "audio/pcm;rate=24000",
                            data: base64
                        }]
                    }
                }));
            };

            this.microphoneSource.connect(this.processorNode);
            this.processorNode.connect(this.audioContext.destination);
        } catch (err) {
            console.error(err);
        }
    }

    stopMicrophone() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach(track => track.stop());
            this.mediaStream = null;
        }
        if (this.processorNode) {
            this.processorNode.disconnect();
            this.processorNode = null;
        }
        if (this.microphoneSource) {
            this.microphoneSource.disconnect();
            this.microphoneSource = null;
        }
    }

    ensureAudioContext() {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = 0;

            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 64;
            const bufferLength = this.analyser.frequencyBinCount;
            this.dataArray = new Uint8Array(bufferLength);

            this.gainNode.connect(this.analyser);
            this.analyser.connect(this.audioContext.destination);
        }
    }

    scheduleFinalizeResponse() {
        if (!this.audioContext) return;

        const currentTime = this.audioContext.currentTime;
        let remainingDuration = Math.max(0, this.nextStartTime - currentTime);

        const delayMs = (remainingDuration * 1000) + 200;

        if (this.responseTimeout) clearTimeout(this.responseTimeout);
        this.responseTimeout = setTimeout(() => {
            this.finalizeResponse();
        }, delayMs);
    }

    // lazy asf to put other feature
    // just wait for the next update
    init() {
        this.setupEventListeners();
        this.connect();
    }

    setupEventListeners() {
        this.sendBtn.addEventListener('click', () => this.sendMessage());
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        this.input.addEventListener('input', () => {
            this.input.style.height = 'auto';
            this.input.style.height = (this.input.scrollHeight) + 'px';
            if (this.input.value === '') this.input.style.height = '24px';

            this.updateSendIcon();
        });

        this.closeCallBtn.addEventListener('click', () => this.closeCall());
        this.muteBtn.addEventListener('click', () => this.toggleMute());
    }

    async openCall() {
        this.isCallMode = true;
        const delay = Math.floor(Math.random() * (3000 - 800 + 1)) + 800;

        this.callLoading.style.setProperty('--loading-duration', `${delay}ms`);

        this.callLoading.classList.add('active');

        setTimeout(async () => {
            this.callLoading.classList.remove('active');
            this.callPopup.classList.add('active');

            if (this.gainNode) this.gainNode.gain.value = this.isMuted ? 0 : 1.0;

            this.updateVisualizer();

            await this.startMicrophone();
        }, delay);
    }

    closeCall() {
        this.isCallMode = false;
        if (this.animationId) cancelAnimationFrame(this.animationId);
        if (this.gainNode) this.gainNode.gain.value = 0;
        this.stopMicrophone();
        this.callPopup.classList.remove('active');
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        this.muteBtn.classList.toggle('muted', this.isMuted);
        this.unmuteIcon.classList.toggle('hidden', this.isMuted);
        this.muteIcon.classList.toggle('hidden', !this.isMuted);

        if (this.gainNode && this.isCallMode) {
            this.gainNode.gain.value = this.isMuted ? 0 : 1.0;
        }
    }

    updateSendIcon() {
        if (this.input.value.trim().length > 0) {
            this.waveIcon.classList.remove('active');
            this.arrowIcon.classList.add('active');
        } else {
            this.waveIcon.classList.add('active');
            this.arrowIcon.classList.remove('active');
        }
    }

    updateVisualizer() {
        if (!this.isCallMode) return;

        this.analyser.getByteFrequencyData(this.dataArray);

        const step = Math.floor(this.dataArray.length / 5);
        this.visualizerBars.forEach((bar, i) => {
            const value = this.dataArray[i * step];
            const height = Math.max(10, (value / 255) * 60);
            bar.style.height = `${height}px`;
        });

        this.animationId = requestAnimationFrame(() => this.updateVisualizer());
    }

    ensureTypingIndicator() {
        if (!this.typingBubble) {
            this.typingBubble = document.createElement('div');
            this.typingBubble.className = 'message ai typing';

            const contentSpan = document.createElement('span');
            contentSpan.className = 'text-content';
            contentSpan.textContent = "Perla is typing...";

            this.typingBubble.appendChild(contentSpan);
            this.chatLog.appendChild(this.typingBubble);
            this.chatLog.scrollTop = this.chatLog.scrollHeight;
        }
    }

    finalizeResponse() {
        if (this.typingBubble) {
            const textSpan = this.typingBubble.querySelector('.text-content');
            if (textSpan) {
                if (this.transcriptionBuffer) {
                    textSpan.textContent = this.transcriptionBuffer;

                    const timestamp = document.createElement('span');
                    timestamp.className = 'timestamp';
                    const now = new Date();
                    timestamp.textContent = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;
                    this.typingBubble.appendChild(timestamp);

                    this.typingBubble.classList.remove('typing');
                } else {
                    this.typingBubble.remove();
                }
            }
            this.typingBubble = null;
        } else if (this.transcriptionBuffer) {
            this.appendMessage('ai', this.transcriptionBuffer);
        }

        this.transcriptionBuffer = "";
    }

    appendMessage(role, text) {
        const msgDiv = document.createElement('div');
        msgDiv.className = `message ${role}`;

        const contentSpan = document.createElement('span');
        contentSpan.className = 'text-content';
        contentSpan.textContent = text;
        msgDiv.appendChild(contentSpan);

        const timestamp = document.createElement('span');
        timestamp.className = 'timestamp';
        const now = new Date();
        timestamp.textContent = `${now.getHours()}:${now.getMinutes().toString().padStart(2, '0')}`;

        msgDiv.appendChild(timestamp);
        this.chatLog.appendChild(msgDiv);
        this.chatLog.scrollTop = this.chatLog.scrollHeight;
    }
}

window.addEventListener('DOMContentLoaded', () => {
    new XDERAClient();
});
