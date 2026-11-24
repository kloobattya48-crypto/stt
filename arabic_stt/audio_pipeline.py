"""
ملف معالجة وتدفق الصوت (Audio Processing Pipeline)
يحتوي على:
1. تقليل الضوضاء وفلترة ترددات الكلام البشري (Noise Reduction & Bandpass Filter)
2. التحقق من هوية الصوت (Voice Verification)
"""

import io
import os
import wave
import requests

# محاولة استيراد مكتبات المعالجة الرقمية للصوت
try:
    import numpy as np
    import scipy.signal as signal
    NUMPY_SCIPY_AVAILABLE = True
except ImportError:
    NUMPY_SCIPY_AVAILABLE = False

try:
    import noisereduce as nr
    NOISEREDUCE_AVAILABLE = True
except ImportError:
    NOISEREDUCE_AVAILABLE = False

# ==============================================================================
# إعدادات التحقق من الصوت (Voice Verification Configuration)
# ==============================================================================
# رابط واجهة برمجة التطبيقات للتحقق من الصوت (Voice Verification API Endpoint)
VOICE_VERIFY_URL = os.getenv("VOICE_VERIFY_URL", "https://api.example.com/v1/voice/verify")

# مفتاح الـ API (اختياري / حسب الخدمة المستخدمة)
VOICE_VERIFY_API_KEY = os.getenv("VOICE_VERIFY_API_KEY", "")

# الوضع التجريبي المؤقت (Mock Mode) - اجعله False عند ربط API حقيقي
MOCK_VOICE_VERIFICATION = True


# ==============================================================================
# 1. دالة تقليل الضوضاء وفلترة الصوت (Remove Noise & Bandpass Filter)
# ==============================================================================
def remove_noise(wav_bytes: bytes) -> bytes:
    """
    تستقبل بيانات صوتية بصيغة WAV (PCM 16-bit) وتقوم بـ:
    - فلترة ترددات الكلام البشري (Bandpass Filter: 80Hz - 3400Hz) باستخدام scipy
    - تقليل الضوضاء الخلفية باستخدام noisereduce (إذا كانت مثبتة)
    - ترجع بيانات WAV نظيفة ومطابقة للمواصفات القياسية.
    - في حال حدوث أي خطأ، يتم إرجاع الصوت الأصلي بأمان دون توقف البرنامج.
    """
    if not wav_bytes or not NUMPY_SCIPY_AVAILABLE:
        return wav_bytes

    try:
        # قراءة ملف الـ WAV من الذاكرة
        with wave.open(io.BytesIO(wav_bytes), 'rb') as wav_in:
            n_channels = wav_in.getnchannels()
            sampwidth = wav_in.getsampwidth()
            framerate = wav_in.getframerate()
            n_frames = wav_in.getnframes()
            raw_frames = wav_in.readframes(n_frames)

        # التحقق من أن التنسيق هو PCM 16-bit (2 بايت لكل عينة)
        if sampwidth != 2 or n_frames == 0:
            return wav_bytes

        # تحويل البيانات إلى مصفوفة numpy
        audio_data = np.frombuffer(raw_frames, dtype=np.int16)

        # إذا كان الصوت ستيريو أو متعدد القنوات، نقوم بفصل القنوات ومعالجتها
        if n_channels > 1:
            audio_data = audio_data.reshape(-1, n_channels)

        processed = audio_data.astype(np.float32)

        # أ) فلتر النطاق الترددي لصوت الإنسان (Bandpass Filter: 80Hz إلى 3400Hz)
        nyquist = 0.5 * framerate
        low_cut = 80.0
        high_cut = min(3400.0, nyquist * 0.95)

        if low_cut < high_cut and low_cut < nyquist:
            low = low_cut / nyquist
            high = high_cut / nyquist
            sos = signal.butter(4, [low, high], btype='bandpass', output='sos')
            
            if n_channels == 1:
                processed = signal.sosfilt(sos, processed)
            else:
                for ch in range(n_channels):
                    processed[:, ch] = signal.sosfilt(sos, processed[:, ch])

        # ب) تقليل الضوضاء المتبقية عبر noisereduce إذا كانت المكتبة مثبتة
        if NOISEREDUCE_AVAILABLE:
            try:
                if n_channels == 1:
                    processed = nr.reduce_noise(
                        y=processed,
                        sr=framerate,
                        prop_decrease=0.75,
                        stationary=True
                    )
                else:
                    for ch in range(n_channels):
                        processed[:, ch] = nr.reduce_noise(
                            y=processed[:, ch],
                            sr=framerate,
                            prop_decrease=0.75,
                            stationary=True
                        )
            except Exception as e:
                # تجاوز أي خطأ فرعي في noisereduce والاعتماد على الفلترة
                pass

        # إعادة القيم إلى حدود 16-bit PCM السليمة (-32768 إلى 32767)
        processed_int16 = np.clip(processed, -32768, 32767).astype(np.int16)

        # إعادة بناء ملف الـ WAV في الذاكرة
        out_io = io.BytesIO()
        with wave.open(out_io, 'wb') as wav_out:
            wav_out.setnchannels(n_channels)
            wav_out.setsampwidth(sampwidth)
            wav_out.setframerate(framerate)
            wav_out.writeframes(processed_int16.tobytes())

        return out_io.getvalue()

    except Exception as e:
        # إرجاع الصوت الأصلي بأمان في حال حدوث أي خطأ غير متوقع
        print(f"[audio_pipeline] تنبيه: تعذر تنظيف الصوت، تم إرجاع الصوت الأصلي ({e})")
        return wav_bytes


# ==============================================================================
# 2. دالة التحقق من الصوت (Voice Verification)
# ==============================================================================
def verify_voice(wav_bytes: bytes) -> dict:
    """
    تستقبل الصوت المعالج وترسله إلى Voice Verification API للتأكد من هوية المتحدث.
    تُرجع قاموساً موحداً بالشكل:
    {
        "allowed": bool,    # هل الصوت مطابق ومصرح له؟
        "message": str,     # رسالة توضيحية للمستخدم
        "raw": any          # الاستجابة الأصلية من الخادم/الـ API
    }
    """
    if not wav_bytes or len(wav_bytes) == 0:
        return {
            "allowed": False,
            "message": "ملف الصوت فارغ أو غير صالح",
            "raw": None
        }

    # --- الوضع التجريبي المؤقت (Mock Mode) ---
    if MOCK_VOICE_VERIFICATION:
        # فحص بدائي للتأكد من وجود بيانات WAV صالحة في الوضع التجريبي
        try:
            with wave.open(io.BytesIO(wav_bytes), 'rb') as w:
                duration_sec = w.getnframes() / float(w.getframerate())
            
            # مثال تجريبي: إذا كان التسجيل أقصر من 0.3 ثانية نعتبره غير كافٍ
            if duration_sec < 0.3:
                return {
                    "allowed": False,
                    "message": "التسجيل الصوتي قصير جداً للتحقق من الهوية",
                    "raw": {"duration": duration_sec, "mock": True}
                }

            return {
                "allowed": True,
                "message": "تم التحقق من هوية الصوت بنجاح (وضع تجريبي)",
                "raw": {
                    "mock": True,
                    "status": "verified",
                    "confidence": 0.96,
                    "duration": round(duration_sec, 2)
                }
            }
        except Exception as e:
            return {
                "allowed": False,
                "message": f"تعذر قراءة الملف الصوتي في الوضع التجريبي: {e}",
                "raw": {"mock": True, "error": str(e)}
            }

    # --- الاتصال بالـ API الفعلي (Real Voice Verification API) ---
    try:
        headers = {}
        if VOICE_VERIFY_API_KEY:
            headers["Authorization"] = f"Bearer {VOICE_VERIFY_API_KEY}"

        files = {
            "audio": ("voice.wav", wav_bytes, "audio/wav")
        }

        response = requests.post(
            VOICE_VERIFY_URL,
            files=files,
            headers=headers,
            timeout=10
        )

        if response.status_code == 200:
            data = response.json() if response.headers.get("Content-Type", "").startswith("application/json") else {}
            # التحقق من الحقول الشائعة في خدمات التحقق الصوتي (is_verified, allowed, match, إلخ)
            is_allowed = data.get("allowed", data.get("is_verified", data.get("match", False)))
            message = data.get("message", "تم التحقق بنجاح" if is_allowed else "الصوت غير مطابق للشخص المصرح له")

            return {
                "allowed": bool(is_allowed),
                "message": message,
                "raw": data
            }
        else:
            return {
                "allowed": False,
                "message": f"فشل التحقق من الصوت (كود الاستجابة: {response.status_code})",
                "raw": response.text
            }

    except requests.exceptions.Timeout:
        return {
            "allowed": False,
            "message": "انتهت مهلة الاتصال بخدمة التحقق من الصوت",
            "raw": None
        }
    except Exception as e:
        return {
            "allowed": False,
            "message": f"خطأ أثناء الاتصال بخدمة التحقق من الصوت: {e}",
            "raw": str(e)
        }


# ==============================================================================
# اختبار تجريبي عند تشغيل الملف مباشرة
# ==============================================================================
if __name__ == "__main__":
    test_file = "test.wav.wav"
    if os.path.exists(test_file):
        print(f"قراءة ملف الاختبار: {test_file}")
        with open(test_file, "rb") as f:
            original_bytes = f.read()

        print(f"الحجم الأصلي: {len(original_bytes)} بايت")

        # تجربة تقليل الضوضاء
        cleaned_bytes = remove_noise(original_bytes)
        print(f"الحجم بعد التنقية: {len(cleaned_bytes)} بايت")

        # تجربة التحقق من الصوت
        verification = verify_voice(cleaned_bytes)
        print("نتيجة التحقق من الصوت:", verification)
    else:
        print("ملف test.wav.wav غير موجود لاختبار pipeline.")
