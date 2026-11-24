// ==========================================
// Arabic Speech-to-Text Application (JavaScript)
// ==========================================

// Global State
let recognition = null;
let isRecording = false;
let isAutoModeActive = false; // هل وضع المايك التلقائي قيد التفعيل بواسطة المستخدم
let silenceTimer = null;
const SILENCE_TIMEOUT_MS = 5000; // مهلة الإيقاف التلقائي عند السكوت (5000 مللي ثانية)
let lastInterim = '';
let timerInterval = null;
let recordingSeconds = 0;
let finalTranscript = '';
let selectedFile = null;

// Web Audio API VAD (مراقبة مستوى الصوت في الخلفية في وضع الاستعداد)
let vadAudioContext = null;
let vadMediaStream = null;
let vadAnalyser = null;
let vadAnimFrame = null;
let isVADMonitoring = false;
const VAD_THRESHOLD = 0.07; // عتبة حساسية رصد الصوت

// DOM Elements
const micSection = document.getElementById('mic-section');
const fileSection = document.getElementById('file-section');
const tabMic = document.getElementById('tab-mic');
const tabFile = document.getElementById('tab-file');

const micToggleBtn = document.getElementById('mic-toggle-btn');
const micIcon = document.getElementById('mic-icon');
const micStatus = document.getElementById('mic-status');
const recordingTimer = document.getElementById('recording-timer');
const soundWave = document.getElementById('sound-wave');
const micLanguage = document.getElementById('mic-language');

const dropZone = document.getElementById('drop-zone');
const audioFileInput = document.getElementById('audio-file-input');
const fileInfoCard = document.getElementById('file-info-card');
const fileName = document.getElementById('file-name');
const fileSize = document.getElementById('file-size');
const audioPreview = document.getElementById('audio-preview');
const transcribeFileBtn = document.getElementById('transcribe-file-btn');
const fileLoading = document.getElementById('file-loading');
const loadingMsg = document.getElementById('loading-msg');

const resultText = document.getElementById('result-text');
const wordCount = document.getElementById('word-count');
const charCount = document.getElementById('char-count');
const copyBtn = document.getElementById('copy-btn');
const speakBtn = document.getElementById('speak-btn');
const downloadBtn = document.getElementById('download-btn');
const clearBtn = document.getElementById('clear-btn');
const toast = document.getElementById('toast');

// --- 1. Tab Switching ---
function switchTab(tab) {
    if (tab === 'mic') {
        tabMic.classList.add('active');
        tabFile.classList.remove('active');
        micSection.classList.add('active');
        fileSection.classList.remove('active');
    } else {
        tabFile.classList.add('active');
        tabMic.classList.remove('active');
        fileSection.classList.add('active');
        micSection.classList.remove('active');
        // إيقاف وتصفير كافة موارد ومراقبة الصوت عند الانتقال لتبويب رفع الملفات
        stopAllAudioSessions();
    }
}

// --- 2. Web Speech API + Web Audio API VAD (التحويل اللحظي مع المراقبة الذكية بالخلفية) ---
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

// دالة لتنظيف النص من علامات الترقيم التلقائية (الفواصل، النقط، علامات الاستفهام والتعجب) وتوحيد المسافات
function cleanPunctuation(text) {
    if (!text) return '';
    return text
        // إزالة النقط، الفواصل العربية واللاتينية، علامات الاستفهام والتعجب، وباقي علامات الترقيم
        .replace(/[.,،؛؟!:;?!"'«»“”‘’()[\]{}\-—_…ـ]/g, '')
        // توحيد المسافات الزائدة لتصبح مسافة واحدة فقط
        .replace(/\s+/g, ' ')
        .trim();
}

// مسح مؤقت السكوت بشكل آمن
function clearSilenceTimer() {
    if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
        console.log('[STT] تم إلغاء مؤقت السكوت');
    }
}

// بدء أو إعادة تصفير مؤقت السكوت
function resetSilenceTimer() {
    clearSilenceTimer();
    if (!isRecording) return;

    console.log('[STT] إعادة ضبط مؤقت السكوت...');
    silenceTimer = setTimeout(() => {
        console.log('[STT] تم رصد السكوت وتوقف الكلام، جاري إنهاء الجلسة الحالية...');
        if (isRecording) {
            // إيقاف تلقائي للجلسة الحالية بسبب السكوت للانتقال لوضع المراقبة
            stopRecording(false);
        }
    }, SILENCE_TIMEOUT_MS);
}

// تشغيل مراقبة الصوت الخفيفة في الخلفية عبر Web Audio API
async function startVADMonitor() {
    if (!isAutoModeActive || isRecording || isVADMonitoring) return;
    if (document.hidden) return;

    try {
        isVADMonitoring = true;
        console.log('[VAD] بدء مراقبة مستوى الصوت في الخلفية في وضع الاستعداد...');
        micStatus.textContent = '👂 في انتظار سماع صوتك للتسجيل تلقائياً...';
        micToggleBtn.classList.add('recording');
        micIcon.textContent = '👂';
        soundWave.classList.add('hidden'); // إخفاء الأمواج أثناء الصمت

        vadMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (!isVADMonitoring || !isAutoModeActive) {
            if (vadMediaStream) {
                vadMediaStream.getTracks().forEach(track => track.stop());
                vadMediaStream = null;
            }
            return;
        }

        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        vadAudioContext = new AudioContextClass();
        const source = vadAudioContext.createMediaStreamSource(vadMediaStream);
        vadAnalyser = vadAudioContext.createAnalyser();
        vadAnalyser.fftSize = 256;
        source.connect(vadAnalyser);

        const dataArray = new Uint8Array(vadAnalyser.frequencyBinCount);

        function checkLevel() {
            if (!isVADMonitoring || !isAutoModeActive) return;

            vadAnalyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                sum += dataArray[i];
            }
            const average = sum / dataArray.length / 255;

            // عند رصد صوت كلام واضح
            if (average > VAD_THRESHOLD) {
                console.log(`[VAD] تم رصد صوت كلام واضح (مستوى الصوت: ${average.toFixed(2)})! جاري بدء التسجيل فوراً...`);
                stopVADMonitor();
                startRecording();
                return;
            }

            vadAnimFrame = requestAnimationFrame(checkLevel);
        }

        checkLevel();
    } catch (err) {
        console.error('[VAD] تعذر تشغيل مراقبة الصوت:', err);
        stopVADMonitor();
        isAutoModeActive = false;
        cleanupRecordingState();
    }
}

// إيقاف مراقبة الصوت في الخلفية وتصفير الموارد بالكامل
function stopVADMonitor() {
    isVADMonitoring = false;
    if (vadAnimFrame) {
        cancelAnimationFrame(vadAnimFrame);
        vadAnimFrame = null;
    }
    if (vadMediaStream) {
        vadMediaStream.getTracks().forEach(track => track.stop());
        vadMediaStream = null;
    }
    if (vadAudioContext) {
        try {
            vadAudioContext.close();
        } catch (e) {}
        vadAudioContext = null;
    }
    console.log('[VAD] تم إيقاف مراقبة الصوت في الخلفية وتصفير الموارد');
}

function setupRecognition() {
    if (!SpeechRecognition) return null;

    const rec = new SpeechRecognition();
    rec.continuous = true; // الاستماع المستمر والكتابة اللحظية
    rec.interimResults = true; // كتابة الكلمات لحظة بلحظة أثناء النطق
    rec.lang = micLanguage.value || 'ar-EG';

    rec.onstart = () => {
        console.log('[STT] onstart: تم فتح الميكروفون وبدء الاستماع بنجاح');
        isRecording = true;
        micToggleBtn.classList.add('recording');
        micIcon.textContent = '⏹️';
        micStatus.textContent = '🎙️ جاري الاستماع... تحدث الآن';
        recordingTimer.classList.remove('hidden');
        soundWave.classList.remove('hidden');
        startTimer();

        // بدء احتساب مهلة السكوت
        resetSilenceTimer();
    };

    rec.onspeechstart = () => {
        console.log('[STT] onspeechstart: تم رصد بداية الصوت والكلام');
        if (isRecording) {
            micStatus.textContent = '🗣️ جاري التقاط الكلام...';
            resetSilenceTimer();
        }
    };

    rec.onspeechend = () => {
        console.log('[STT] onspeechend: تم رصد توقف الكلام');
        if (isRecording) {
            micStatus.textContent = '⏳ جاري انتظار استكمال الكلام...';
        }
    };

    rec.onresult = (event) => {
        let interimTranscript = '';
        console.log(`[STT] onresult: حدث جديد، عدد النتائج = ${event.results.length}، الفهرس = ${event.resultIndex}`);

        // تصفير وإعادة تشغيل مؤقت السكوت طالما توجد نتائج كلام جديدة
        resetSilenceTimer();

        for (let i = event.resultIndex; i < event.results.length; ++i) {
            const rawTranscript = event.results[i][0].transcript;
            const cleaned = cleanPunctuation(rawTranscript);

            if (event.results[i].isFinal) {
                if (cleaned) {
                    console.log(`[STT] onresult (Final): "${cleaned}"`);
                    finalTranscript = (finalTranscript.trim() + ' ' + cleaned).trim() + ' ';
                }
                lastInterim = '';
            } else if (isRecording) {
                if (cleaned) {
                    interimTranscript += cleaned + ' ';
                }
            }
        }

        const cleanedInterim = cleanPunctuation(interimTranscript);

        if (isRecording) {
            lastInterim = cleanedInterim;
            const combined = (finalTranscript.trim() + ' ' + cleanedInterim).trim();
            resultText.value = combined;
            
            if (cleanedInterim) {
                console.log(`[STT] onresult (Interim): "${cleanedInterim}"`);
                micStatus.textContent = `🗣️ يكتب لحظياً: ${cleanedInterim}`;
            }
        } else {
            resultText.value = cleanPunctuation(finalTranscript);
        }

        resultText.scrollTop = resultText.scrollHeight;
        updateStats();
    };

    rec.onerror = (event) => {
        console.error('[STT] onerror: حدث خطأ أثناء التسجيل:', event.error, event);
        if (event.error === 'no-speech') {
            console.warn('[STT] تنبيه no-speech من المتصفح (مؤقت السكوت لا يزال نشطاً)');
            return;
        }

        // مسح المؤقت فوراً وتصفير الموارد عند حدوث أي خطأ
        clearSilenceTimer();

        if (event.error === 'not-allowed') {
            showToast('⚠️ يرجى السماح للمتصفح بالوصول إلى الميكروفون');
            micStatus.textContent = 'تم رفض الإذن بالوصول للميكروفون';
        } else if (event.error === 'audio-capture') {
            showToast('⚠️ لم يتم العثور على ميكروفون صالح أو تعذر الوصول إليه');
            micStatus.textContent = 'خطأ في التقاط الصوت';
        } else if (event.error === 'network') {
            showToast('⚠️ تنبيه: بطء أو انقطاع في الاتصال بالشبكة');
            micStatus.textContent = 'تنبيه: بطء في الاتصال بالشبكة...';
        } else {
            micStatus.textContent = `تنبيه: ${event.error}`;
        }

        stopAllAudioSessions();
    };

    rec.onend = () => {
        console.log('[STT] onend: انتهت جلسة التعرف على الصوت');

        clearSilenceTimer();

        // تثبيت أي مقطع أخير متبقٍ في الذاكرة دون تكرار وبدون أي علامات ترقيم
        if (lastInterim.trim()) {
            const cleanedLast = cleanPunctuation(lastInterim);
            if (cleanedLast) {
                finalTranscript = (finalTranscript.trim() + ' ' + cleanedLast).trim() + ' ';
            }
            lastInterim = '';
        }

        resultText.value = cleanPunctuation(finalTranscript);
        finalTranscript = resultText.value;
        if (finalTranscript) {
            finalTranscript += ' ';
        }

        updateStats();

        isRecording = false;

        // إذا كان وضع المايك لا يزال مفعلاً والتبويب نشط، ننتقل لمراقبة الصوت بالخلفية
        if (isAutoModeActive && !document.hidden) {
            console.log('[STT] التحول لمراقبة الصوت في الخلفية (VAD Standby)...');
            startVADMonitor();
        } else {
            cleanupRecordingState();
            micStatus.textContent = '✅ تم تثبيت النص وتوقف التسجيل';
        }
    };

    return rec;
}

function cleanupRecordingState() {
    clearSilenceTimer();
    isRecording = false;
    lastInterim = '';
    stopRecordingUI();
}

function startRecording() {
    console.log('[STT] استدعاء startRecording()...');

    if (!SpeechRecognition) {
        console.error('[STT] متصفحك لا يدعم Web Speech API');
        showToast('متصفحك لا يدعم Web Speech API. يرجى استخدام متصفح Google Chrome أو Microsoft Edge.');
        micStatus.textContent = 'متصفحك لا يدعم Web Speech API';
        isAutoModeActive = false;
        return;
    }

    // إيقاف مراقبة VAD أولاً لضمان تحرير جهاز الميكروفون
    stopVADMonitor();
    clearSilenceTimer();

    if (recognition) {
        try {
            recognition.abort();
        } catch (e) {}
    }

    recognition = setupRecognition();
    if (!recognition) return;

    lastInterim = '';
    finalTranscript = cleanPunctuation(resultText.value);
    if (finalTranscript.length > 0) {
        finalTranscript += ' ';
    }

    try {
        recognition.start();
        console.log('[STT] تم استدعاء recognition.start() بنجاح وبدء تشغيل الميكروفون');
    } catch (err) {
        console.error('[STT] استثناء عند recognition.start():', err);
        cleanupRecordingState();
        isAutoModeActive = false;
    }
}

function stopRecording(isManual = false) {
    console.log(`[STT] استدعاء stopRecording (يدوي: ${isManual})...`);
    clearSilenceTimer();
    isRecording = false;

    if (isManual) {
        isAutoModeActive = false;
        stopVADMonitor();
    }

    if (recognition) {
        try {
            recognition.stop();
        } catch (e) {
            console.warn('[STT] تحذير عند إيقاف recognition:', e);
        }
    }

    if (lastInterim.trim()) {
        const cleanedLast = cleanPunctuation(lastInterim);
        if (cleanedLast) {
            finalTranscript = (finalTranscript.trim() + ' ' + cleanedLast).trim() + ' ';
        }
        lastInterim = '';
    }

    resultText.value = cleanPunctuation(finalTranscript);
    finalTranscript = resultText.value;
    if (finalTranscript) {
        finalTranscript += ' ';
    }

    updateStats();
    if (isManual) {
        cleanupRecordingState();
        micStatus.textContent = '✅ تم تثبيت النص وتوقف التسجيل';
    }
}

// إيقاف يدوي كامل وتصفير لكافة الموارد والمراقبة
function stopAllAudioSessions() {
    console.log('[STT] إيقاف كامل لجميع العمليات ومراقبة الصوت وتصفير الموارد');
    isAutoModeActive = false;
    stopVADMonitor();
    stopRecording(true);
    cleanupRecordingState();
    micStatus.textContent = '✅ تم تثبيت النص وتوقف التسجيل';
}

function stopRecordingUI() {
    micToggleBtn.classList.remove('recording');
    micToggleBtn.disabled = false;
    micIcon.textContent = '🎤';
    recordingTimer.classList.add('hidden');
    soundWave.classList.add('hidden');
    stopTimer();
}

micToggleBtn.addEventListener('click', () => {
    console.log('[STT] تم النقر على زر الميكروفون. الحالة isAutoModeActive =', isAutoModeActive);
    if (isAutoModeActive) {
        stopAllAudioSessions();
    } else {
        isAutoModeActive = true;
        startRecording();
    }
});

micLanguage.addEventListener('change', () => {
    console.log('[STT] تم تغيير اللغة إلى:', micLanguage.value);
    if (recognition) {
        recognition.lang = micLanguage.value;
        if (isAutoModeActive) {
            stopAllAudioSessions();
        }
    }
});

// إيقاف وتصفير الموارد فوراً عند مغادرة أو إخفاء التبويب
document.addEventListener('visibilitychange', () => {
    if (document.hidden && isAutoModeActive) {
        console.log('[STT] تم إخفاء التبويب، جاري إيقاف مراقبة الصوت وتصفير الموارد...');
        stopAllAudioSessions();
    }
});

window.addEventListener('beforeunload', () => {
    stopAllAudioSessions();
});

// Timer helpers
function startTimer() {
    recordingSeconds = 0;
    recordingTimer.textContent = '00:00';
    clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        recordingSeconds++;
        const mins = String(Math.floor(recordingSeconds / 60)).padStart(2, '0');
        const secs = String(recordingSeconds % 60).padStart(2, '0');
        recordingTimer.textContent = `${mins}:${secs}`;
    }, 1000);
}

function stopTimer() {
    clearInterval(timerInterval);
    recordingSeconds = 0;
}

// --- 3. Audio File Handling & In-Browser Audio Normalization ---
dropZone.addEventListener('click', () => audioFileInput.click());

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleFileSelected(e.dataTransfer.files[0]);
    }
});

audioFileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
        handleFileSelected(e.target.files[0]);
    }
});

function handleFileSelected(file) {
    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = `${(file.size / (1024 * 1024)).toFixed(2)} ميجابايت`;

    // Preview audio
    const objectUrl = URL.createObjectURL(file);
    audioPreview.src = objectUrl;

    fileInfoCard.classList.remove('hidden');
}

/**
 * تحويل أي صيغة صوتية (MP3, M4A, OGG, WAV) إلى ملف WAV أحادي نقي 16kHz
 * داخل المتصفح مباشرة باستخدام Web Audio API دون الحاجة لأي مكتبات أو ffmpeg محلياً!
 */
async function convertAudioFileToWavBlob(file) {
    const arrayBuffer = await file.arrayBuffer();
    const AudioCtxClass = window.AudioContext || window.webkitAudioContext;
    const audioCtx = new AudioCtxClass();
    
    // فك تشفير الصوت بواسطة المتصفح
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    
    // تحويل التردد إلى 16000Hz (التردد المثالي للتعرف على الصوت)
    const targetSampleRate = 16000;
    const totalSamples = Math.ceil(audioBuffer.duration * targetSampleRate);
    const offlineCtx = new OfflineAudioContext(1, totalSamples, targetSampleRate);
    
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offlineCtx.destination);
    source.start(0);
    
    const resampledBuffer = await offlineCtx.startRendering();
    return encodeAudioBufferToWav(resampledBuffer);
}

function encodeAudioBufferToWav(buffer) {
    const numOfChan = 1;
    const sampleRate = buffer.sampleRate;
    const samples = buffer.getChannelData(0);
    const dataLen = samples.length * 2; // 16-bit PCM (2 bytes per sample)
    const bufferLen = 44 + dataLen;
    const arrayBuffer = new ArrayBuffer(bufferLen);
    const view = new DataView(arrayBuffer);

    // RIFF chunk descriptor
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLen, true);
    writeString(view, 8, 'WAVE');

    // fmt sub-chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);           // SubChunk1Size (16 for PCM)
    view.setUint16(20, 1, true);            // AudioFormat (1 = PCM)
    view.setUint16(22, numOfChan, true);    // NumChannels (1 = Mono)
    view.setUint32(24, sampleRate, true);   // SampleRate
    view.setUint32(28, sampleRate * 2, true);// ByteRate (SampleRate * NumChannels * BitsPerSample/8)
    view.setUint16(32, 2, true);            // BlockAlign (NumChannels * BitsPerSample/8)
    view.setUint16(34, 16, true);           // BitsPerSample (16 bits)

    // data sub-chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataLen, true);

    // Write PCM 16-bit audio samples
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }

    return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}

// Transcribe File via lightweight backend API
transcribeFileBtn.addEventListener('click', async () => {
    if (!selectedFile) {
        showToast('يرجى اختيار ملف صوتي أولاً');
        return;
    }

    fileLoading.classList.remove('hidden');
    transcribeFileBtn.disabled = true;
    loadingMsg.textContent = 'جاري معالجة الصوت وتحضير التردد المناسب...';

    try {
        // تحويل الصوت إلى صيغة WAV موحدة في المتصفح
        const wavBlob = await convertAudioFileToWavBlob(selectedFile);

        loadingMsg.textContent = 'جاري إرسال الصوت واستخراج الكلمات العربية...';

        const response = await fetch('/api/transcribe', {
            method: 'POST',
            headers: {
                'Content-Type': 'audio/wav',
                'X-Filename': encodeURIComponent(selectedFile.name)
            },
            body: wavBlob
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error || `خطأ في الخادم (${response.status})`);
        }

        const data = await response.json();
        if (data.error) {
            showToast(`⚠️ ${data.error}`);
        } else if (data.text) {
            const cleanedFileText = cleanPunctuation(data.text);
            resultText.value = (resultText.value ? resultText.value + '\n' : '') + cleanedFileText;
            finalTranscript = resultText.value;
            updateStats();
            showToast('✨ تم استخراج النص بنجاح!');
        } else {
            showToast('لم يتم العثور على كلام واضح في التسجيل.');
        }
    } catch (error) {
        console.error('Transcription error:', error);
        showToast(`⚠️ ${error.message || 'تعذر معالجة الملف. تأكدي من تشغيل python app.py'}`);
    } finally {
        fileLoading.classList.add('hidden');
        transcribeFileBtn.disabled = false;
    }
});

// --- 4. Result Textarea Helpers ---
function updateStats() {
    const text = resultText.value.trim();
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const chars = text.length;
    wordCount.textContent = `${words} كلمة`;
    charCount.textContent = `${chars} حرف`;
}

resultText.addEventListener('input', () => {
    if (!isRecording) {
        finalTranscript = resultText.value;
    }
    updateStats();
});

// Copy Button
copyBtn.addEventListener('click', async () => {
    const text = resultText.value;
    if (!text.trim()) {
        showToast('لا يوجد نص للنسخ');
        return;
    }
    try {
        await navigator.clipboard.writeText(text);
        showToast('📋 تم نسخ النص إلى الحافظة بنجاح!');
    } catch (err) {
        resultText.select();
        document.execCommand('copy');
        showToast('📋 تم نسخ النص!');
    }
});

// Speak (Text-to-Speech)
speakBtn.addEventListener('click', () => {
    const text = resultText.value.trim();
    if (!text) {
        showToast('لا يوجد نص للاستماع إليه');
        return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ar-SA';
    window.speechSynthesis.speak(utterance);
    showToast('🔊 جاري قراءة النص...');
});

// Download Text File (.txt)
downloadBtn.addEventListener('click', () => {
    const text = resultText.value.trim();
    if (!text) {
        showToast('لا يوجد نص لتحميله');
        return;
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `arabic_transcription_${Date.now()}.txt`;
    link.click();
    showToast('💾 تم تحميل الملف النصي!');
});

// Clear Text
clearBtn.addEventListener('click', () => {
    if (resultText.value && confirm('هل أنتِ متأكدة من مسح النص؟')) {
        resultText.value = '';
        finalTranscript = '';
        lastInterim = '';
        updateStats();
        showToast('تم مسح النص');
    }
});

// Toast Helper
function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3200);
}
